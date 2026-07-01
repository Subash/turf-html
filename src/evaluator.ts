import type { DirectiveSegment, GetOperation, ParsedSource, PathOperation, SetOperation } from './parser.ts';
import type { SourceEnvelope, SourcePosition } from './scanner.ts';
import TurfSyntaxError from './syntax-error.ts';

export type InitialVariables = Record<string, unknown>;

export interface RenderContext {
  base64: boolean;
  variables: Record<string, string>;
  file?: string;
  location: SourcePosition;
}

export type EvaluationRenderer = (path: string, context: RenderContext) => string | Promise<string>;

export interface EvaluatorOptions {
  variables?: InitialVariables;
  renderInclude?: EvaluationRenderer;
  compileDelegate?: EvaluationRenderer;
}

interface EvaluationResult {
  output: string;
  silent: boolean;
}

export class TurfEvaluator {
  #parsed: ParsedSource;
  #options: EvaluatorOptions;
  #scope: Map<string, string>;
  #chunks: string[] = [];
  #cursor: number = 0;

  constructor(parsed: unknown, options: EvaluatorOptions = {}) {
    this.#assertValidParsedSource(parsed);
    this.#parsed = parsed;
    this.#options = options;
    this.#scope = this.#createVariableScope(options.variables ?? {});
  }

  #assertValidParsedSource(parsed: unknown): asserts parsed is ParsedSource {
    const candidate = parsed as Partial<ParsedSource> | null | undefined;
    const hasSource = typeof candidate?.source === 'string';
    const hasSegments = Array.isArray(candidate?.segments);
    if (hasSource && hasSegments) return;
    throw new TypeError('TurfEvaluator expects the result of TurfParser.parse().');
  }

  #createVariableScope(variables: InitialVariables): Map<string, string> {
    this.#assertPlainVariableObject(variables);
    const scope = new Map();

    for (const [name, value] of Object.entries(variables)) {
      if (value === undefined) continue;
      const normalizedName = name.toLowerCase();
      const normalizedValue = this.#normalizeVariableValue(name, value);
      scope.set(normalizedName, normalizedValue);
    }

    return scope;
  }

  #assertPlainVariableObject(variables: unknown): asserts variables is InitialVariables {
    const isObject = variables !== null && typeof variables === 'object';
    const hasPlainPrototype = isObject && Object.getPrototypeOf(variables) === Object.prototype;
    if (hasPlainPrototype) return;
    throw new TypeError('variables must be a plain object.');
  }

  #normalizeVariableValue(name: string, value: unknown): string {
    if (value === null) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);

    throw this.#createSyntaxError(
      undefined,
      'TURF_INVALID_VARIABLE_VALUE',
      `Invalid initial value for variable ${name}.`
    );
  }

  async evaluate(): Promise<string> {
    for (const segment of this.#getDirectiveSegments()) {
      await this.#evaluateDirective(segment);
    }

    this.#chunks.push(this.#parsed.source.slice(this.#cursor));
    return this.#chunks.join('');
  }

  #getDirectiveSegments(): DirectiveSegment[] {
    return this.#parsed.segments.filter((segment): segment is DirectiveSegment => segment.type === 'directive');
  }

  async #evaluateDirective(segment: DirectiveSegment): Promise<void> {
    const result = await this.#evaluateOperation(segment);
    const range = this.#createReplacementRange(segment, result.silent);
    const unchangedSource = this.#parsed.source.slice(this.#cursor, range.start);
    const replacement = this.#createReplacementOutput(segment, result);
    this.#chunks.push(unchangedSource);
    this.#chunks.push(replacement);
    this.#cursor = range.end;
  }

  #evaluateOperation(segment: DirectiveSegment): EvaluationResult | Promise<EvaluationResult> {
    const operation = segment.operation;

    switch (operation.type) {
      case 'set':
        return this.#assignVariable(operation);
      case 'get':
        return this.#readVariable(operation, segment);
      case 'include':
      case 'compile':
        return this.#renderPaths(operation, segment);
      default:
        throw new TypeError('Unknown operation type.');
    }
  }

  #assignVariable(operation: SetOperation): EvaluationResult {
    this.#scope.set(operation.name, operation.value);
    return { output: '', silent: true };
  }

  #readVariable(operation: GetOperation, segment: DirectiveSegment): EvaluationResult {
    if (this.#scope.has(operation.name)) {
      const output = this.#scope.get(operation.name) as string;
      return { output, silent: false };
    }

    if (operation.optional) return { output: '', silent: false };

    throw this.#createSyntaxError(segment, 'TURF_MISSING_VARIABLE', `Undefined variable: ${operation.originalName}.`);
  }

  async #renderPaths(operation: PathOperation, segment: DirectiveSegment): Promise<EvaluationResult> {
    const renderer = this.#getOperationRenderer(operation, segment);

    const outputs: string[] = [];
    for (const path of operation.paths) {
      const output = await this.#renderPath(renderer, path, operation, segment);
      outputs.push(output);
    }

    const output = this.#joinPathOutputs(outputs);
    return { output, silent: false };
  }

  #getOperationRenderer(operation: PathOperation, segment: DirectiveSegment): EvaluationRenderer {
    if (operation.type === 'include') {
      const renderer = this.#options.renderInclude;
      if (typeof renderer === 'function') return renderer;

      throw this.#createSyntaxError(segment, 'TURF_MISSING_INCLUDE', `Unable to include ${operation.paths[0]}.`);
    }

    const compileDelegate = this.#options.compileDelegate;
    if (typeof compileDelegate === 'function') return compileDelegate;

    throw this.#createSyntaxError(segment, 'TURF_MISSING_DELEGATE', 'No compile delegate is configured.');
  }

  async #renderPath(
    renderer: EvaluationRenderer,
    path: string,
    operation: PathOperation,
    segment: DirectiveSegment
  ): Promise<string> {
    const context = this.#createRenderContext(operation, segment);
    const output = await renderer(path, context);
    this.#assertValidRendererOutput(output, operation);
    return output;
  }

  #createRenderContext(operation: PathOperation, segment: DirectiveSegment): RenderContext {
    const base64 = operation.base64;
    const variables = Object.fromEntries(this.#scope);
    const file = this.#parsed.file;
    const location = segment.location;
    return { base64, variables, file, location };
  }

  #assertValidRendererOutput(output: unknown, operation: PathOperation): asserts output is string {
    if (typeof output !== 'string') {
      throw new TypeError(`${operation.type} renderer must return a string.`);
    }
  }

  #joinPathOutputs(outputs: string[]): string {
    return outputs.reduce((combined, output) => this.#joinPathOutput(combined, output));
  }

  #joinPathOutput(previousOutput: string, nextOutput: string): string {
    const previous = previousOutput.replace(/(?:\n[\t ]*)+$/u, '');
    const next = nextOutput.replace(/^(?:[\t ]*\n)+/u, '');
    return `${previous}\n${next}`;
  }

  #createReplacementRange(segment: DirectiveSegment, silent: boolean): SourceEnvelope {
    if (segment.layout.kind === 'standalone') return segment.layout.envelope;

    const start = segment.range.start.offset;
    const end = segment.range.end.offset;
    const range = { start, end };
    if (!silent || !this.#hasHorizontalWhitespaceBefore(start)) return range;

    return { start, end: this.#findHorizontalWhitespaceEnd(end) };
  }

  #hasHorizontalWhitespaceBefore(offset: number): boolean {
    if (offset === 0) return false;
    return this.#isHorizontalWhitespace(this.#parsed.source[offset - 1]);
  }

  #findHorizontalWhitespaceEnd(start: number): number {
    let end = start;

    while (this.#isHorizontalWhitespace(this.#parsed.source[end])) {
      end += 1;
    }

    return end;
  }

  #createReplacementOutput(segment: DirectiveSegment, result: EvaluationResult): string {
    if (segment.layout.kind !== 'standalone') return result.output;
    if (result.output === '') return '';

    const indented = this.#indentOutput(result.output, segment.layout.indent);
    const envelope = this.#parsed.source.slice(segment.layout.envelope.start, segment.layout.envelope.end);
    if (!this.#needsTrailingLineEnding(indented, envelope)) return indented;

    return `${indented}\n`;
  }

  #indentOutput(output: string, indent: string): string {
    const lines = output.split('\n');
    const indentedLines = lines.map((line) => this.#indentLine(line, indent));
    return indentedLines.join('\n');
  }

  #indentLine(line: string, indent: string): string {
    if (line.length === 0) return line;
    return indent + line;
  }

  #needsTrailingLineEnding(output: string, envelope: string): boolean {
    if (!envelope.endsWith('\n')) return false;
    if (output.endsWith('\n')) return false;
    return true;
  }

  #isHorizontalWhitespace(character: string | undefined): boolean {
    if (character === ' ') return true;
    if (character === '\t') return true;
    return false;
  }

  #createSyntaxError(
    segment: DirectiveSegment | undefined,
    code: string,
    message: string,
    cause?: unknown
  ): TurfSyntaxError {
    const location = segment?.location;
    const file = this.#parsed?.file;
    const line = location?.line;
    const column = location?.column;
    const offset = location?.offset;
    return new TurfSyntaxError(message, { code, file, line, column, offset, cause });
  }

  static evaluate(parsed: unknown, options?: EvaluatorOptions): Promise<string> {
    return new TurfEvaluator(parsed, options).evaluate();
  }
}
