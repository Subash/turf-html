import { Buffer } from 'node:buffer';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { EvaluatorOptions, InitialVariables, RenderContext } from './evaluator.ts';
import { TurfEvaluator } from './evaluator.ts';
import type { OutputPiece, OutputSource } from './output.ts';
import { getOutputSources, getOutputText } from './output.ts';
import { TurfParser } from './parser.ts';
import type { SourcePosition } from './scanner.ts';
import TurfSyntaxError from './syntax-error.ts';

export type { InitialVariables } from './evaluator.ts';
export type { OutputSource as CompileSource } from './output.ts';
export { default as TurfSyntaxError } from './syntax-error.ts';
export type { TurfSyntaxErrorOptions } from './syntax-error.ts';

export interface CompileDelegateContext {
  file: string;
  location: SourcePosition;
  query?: string;
}

export type CompileDelegate = (
  absolutePath: string,
  context: CompileDelegateContext
) => string | Buffer | Promise<string | Buffer>;

export interface CompileResult {
  code: string;
  sources: OutputSource[];
}

export interface CompileOptions {
  file: string;
  rootDir?: string;
  variables?: InitialVariables;
  compileDelegate?: CompileDelegate;
}

const TEMPLATE_EXTENSIONS = ['.kit', '.turf', '.html', '.htm'];

interface CompilerOptions extends CompileOptions {
  ancestry?: string[];
}

class Compiler {
  #source: string;
  #file: string;
  #rootDir: string;
  #baseDir: string;
  #variables: InitialVariables | undefined;
  #compileDelegate: CompileDelegate | undefined;
  #ancestry: string[];

  constructor(source: string, options: CompilerOptions) {
    this.#source = source;
    this.#file = options.file;
    this.#rootDir = options.rootDir || path.dirname(this.#file);
    this.#baseDir = path.dirname(this.#file);
    this.#variables = options.variables;
    this.#compileDelegate = options.compileDelegate;
    this.#ancestry = options.ancestry || [this.#file];
  }

  async compile(): Promise<OutputPiece[]> {
    const parsed = TurfParser.parse(this.#source, { file: this.#file });

    const options: EvaluatorOptions = {
      variables: this.#variables,
      renderInclude: (requestedPath, context) => this.#renderInclude(requestedPath, context)
    };

    if (this.#compileDelegate !== undefined) {
      options.compileDelegate = (requestedPath, context) => this.#renderCompile(requestedPath, context);
    }

    return TurfEvaluator.evaluatePieces(parsed, options);
  }

  async #renderInclude(requestedPath: string, context: RenderContext): Promise<string | OutputPiece[]> {
    const file = await this.#resolveFile(requestedPath, context);
    const data = await readFile(file);

    if (!this.#isTemplate(file)) {
      if (context.base64) return data.toString('base64');
      return data.toString('utf8');
    }

    const output = await this.#compileIncludedFile(file, data, context.variables);
    if (context.base64) return Buffer.from(getOutputText(output), 'utf8').toString('base64');
    return output;
  }

  async #renderCompile(requestedPath: string, context: RenderContext): Promise<string> {
    const queryIndex = requestedPath.indexOf('?');
    const target = queryIndex === -1 ? requestedPath : requestedPath.slice(0, queryIndex);
    const delegateContext: CompileDelegateContext = { file: this.#file, location: context.location };
    if (queryIndex !== -1) delegateContext.query = requestedPath.slice(queryIndex + 1);
    const file = await this.#resolveFile(target, context);
    const compileDelegate = this.#compileDelegate!;
    const output = await compileDelegate(file, delegateContext);
    if (Buffer.isBuffer(output)) return output.toString('base64');
    const normalizedOutput = output.replace(/\r\n/g, '\n');
    if (context.base64) return Buffer.from(normalizedOutput, 'utf8').toString('base64');
    return normalizedOutput;
  }

  async #compileIncludedFile(file: string, data: Buffer, variables: Record<string, string>): Promise<OutputPiece[]> {
    const rootDir = this.#rootDir;
    const compileDelegate = this.#compileDelegate;
    const ancestry = [...this.#ancestry, file];
    return new Compiler(data.toString('utf8'), { file, rootDir, variables, compileDelegate, ancestry }).compile();
  }

  #isTemplate(file: string): boolean {
    const extension = path.extname(file).toLowerCase();
    return TEMPLATE_EXTENSIONS.includes(extension);
  }

  async #resolveFile(requestedPath: string, context: RenderContext): Promise<string> {
    const candidates = this.#getFileCandidates(requestedPath);

    for (const candidate of candidates) {
      if (!(await this.#isFile(candidate))) continue;
      if (this.#ancestry.includes(candidate)) {
        throw this.#createSyntaxError(context, 'TURF_RECURSIVE_INCLUDE', `Recursive include detected: ${candidate}`);
      }
      return candidate;
    }

    throw this.#createSyntaxError(
      context,
      'TURF_FILE_NOT_FOUND',
      `Failed to find the included file \`${requestedPath}\``
    );
  }

  #createSyntaxError(context: RenderContext, code: string, message: string): TurfSyntaxError {
    const { line, column, offset } = context.location;
    return new TurfSyntaxError(message, { code, file: this.#file, line, column, offset });
  }

  #getFileCandidates(requestedPath: string): string[] {
    const file = this.#resolveRequestedPath(requestedPath);
    const directCandidates = this.#getDirectFileCandidates(file);
    const indexCandidates = this.#getDirectoryIndexCandidates(directCandidates);
    return [...directCandidates, ...indexCandidates];
  }

  #resolveRequestedPath(requestedPath: string): string {
    if (requestedPath.startsWith('/')) {
      return path.resolve(this.#rootDir, requestedPath.slice(1));
    }

    return path.resolve(this.#baseDir, requestedPath);
  }

  #getDirectFileCandidates(file: string): string[] {
    const partial = path.join(path.dirname(file), `_${path.basename(file)}`);
    return [file, partial].flatMap((candidate) => this.#getExtensionCandidates(candidate));
  }

  #getDirectoryIndexCandidates(directCandidates: string[]): string[] {
    return directCandidates.flatMap((directory) => this.#getDirectFileCandidates(path.join(directory, 'index')));
  }

  #getExtensionCandidates(file: string): string[] {
    const extensions = TEMPLATE_EXTENSIONS.map((extension) => `${file}${extension}`);
    return [file, ...extensions];
  }

  async #isFile(file: string): Promise<boolean> {
    try {
      const stats = await stat(file);
      return stats.isFile();
    } catch {
      return false;
    }
  }
}

function validateFile(file: unknown): asserts file is string {
  if (typeof file !== 'string' || file.length === 0) {
    throw new TypeError('file is required.');
  }

  if (!path.isAbsolute(file)) {
    throw new TypeError('file must be an absolute path.');
  }
}

export default async function compile(source: string, options: CompileOptions): Promise<string> {
  validateFile(options?.file);
  return getOutputText(await new Compiler(source, options).compile());
}

export async function compileWithSources(source: string, options: CompileOptions): Promise<CompileResult> {
  validateFile(options?.file);
  const pieces = await new Compiler(source, options).compile();
  return { code: getOutputText(pieces), sources: getOutputSources(pieces) };
}
