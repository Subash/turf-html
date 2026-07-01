import type { CommentSegment, ScannedSegment, ScannedSource, ScannerOptions, SourcePosition } from './scanner.ts';
import { TurfScanner } from './scanner.ts';
import TurfSyntaxError from './syntax-error.ts';

export type VariableSigil = '@' | '$';

export interface SetOperation {
  type: 'set';
  sigil: VariableSigil;
  name: string;
  originalName: string;
  value: string;
  quoted: boolean;
}

export interface GetOperation {
  type: 'get';
  sigil: VariableSigil;
  name: string;
  originalName: string;
  optional: boolean;
}

export interface PathOperation {
  type: 'include' | 'compile';
  keyword: string;
  base64: boolean;
  paths: string[];
}

export type TurfOperation = SetOperation | GetOperation | PathOperation;

export interface DirectiveSegment extends Omit<CommentSegment, 'type'> {
  type: 'directive';
  operation: TurfOperation;
  location: SourcePosition;
}

export type ParsedSegment = ScannedSegment | DirectiveSegment;

export interface ParsedSource {
  source: string;
  file?: string;
  segments: ParsedSegment[];
}

interface DirectiveDefinition {
  type: PathOperation['type'];
  base64: boolean;
}

interface DirectiveContext {
  source: string;
  file: string | undefined;
  tokenOffset: number;
}

interface PathItem {
  raw: string;
  offset: number;
}

interface VariableAssignmentSource {
  rawValue: string;
  valueOffset: number;
}

interface ParsedVariableValue {
  value: string;
  quoted: boolean;
}

const VARIABLE_NAME_PATTERN = /^[\p{L}_][\p{L}\p{M}\p{N}_.-]*/u;
const QUOTE_CHARACTERS = new Set(["'", '"', '`']);

const DIRECTIVE_DEFINITIONS = new Map<string, DirectiveDefinition>([
  ['@include', { type: 'include', base64: false }],
  ['@import', { type: 'include', base64: false }],
  ['@include-base64', { type: 'include', base64: true }],
  ['@import-base64', { type: 'include', base64: true }],
  ['@compile', { type: 'compile', base64: false }],
  ['@compile-base64', { type: 'compile', base64: true }]
]);

export class TurfParser {
  #scanned: ScannedSource;

  constructor(scanned: unknown) {
    this.#assertValidScannerResult(scanned);
    this.#scanned = scanned;
  }

  #assertValidScannerResult(scanned: unknown): asserts scanned is ScannedSource {
    const candidate = scanned as Partial<ScannedSource> | null | undefined;
    const hasSource = typeof candidate?.source === 'string';
    const hasSegments = Array.isArray(candidate?.segments);
    if (hasSource && hasSegments) return;
    throw new TypeError('TurfParser expects the result of TurfScanner.scan().');
  }

  parse(): ParsedSource {
    const file = this.#scanned.file;
    const source = this.#scanned.source;
    const segments = this.#scanned.segments.map((segment) => this.#parseSegment(segment));
    return { file, source, segments };
  }

  #parseSegment(segment: ScannedSegment): ParsedSegment {
    return segment.type === 'comment' ? this.#parseComment(segment) : segment;
  }

  #parseComment(segment: CommentSegment): CommentSegment | DirectiveSegment {
    const content = segment.content.trim();
    if (!this.#isDirectiveContent(content)) return segment;

    const context = this.#createDirectiveContext(segment);
    this.#validateDirectiveWrapper(segment, content, context);

    const type = 'directive' as const;
    const operation = this.#parseOperation(content, context);
    const location = TurfScanner.getSourcePosition(this.#scanned.source, context.tokenOffset);
    return { ...segment, type, content, operation, location };
  }

  #isDirectiveContent(content: string): boolean {
    return content.startsWith('@') || content.startsWith('$');
  }

  #createDirectiveContext(segment: CommentSegment): DirectiveContext {
    const source = this.#scanned.source;
    const file = this.#scanned.file;
    const contentOffset = segment.range.start.offset + TurfScanner.COMMENT_START.length;
    const tokenOffset = contentOffset + this.#getLeadingWhitespaceLength(segment.content);
    return { source, file, tokenOffset };
  }

  #validateDirectiveWrapper(segment: CommentSegment, content: string, context: DirectiveContext): void {
    if (content.includes('\n')) {
      this.#throwSyntaxError(
        context,
        0,
        'TURF_MULTILINE_DIRECTIVE',
        'A Turf instruction must occupy one logical line.'
      );
    }

    if (segment.raw.includes('\n') && segment.layout.kind !== 'standalone') {
      this.#throwSyntaxError(
        context,
        0,
        'TURF_INLINE_MULTILINE_DIRECTIVE',
        'A multiline comment wrapper must be standalone.'
      );
    }
  }

  #parseOperation(content: string, context: DirectiveContext): TurfOperation {
    const directive = content.startsWith('@') ? this.#parseReservedDirective(content, context) : null;
    return directive ?? this.#parseVariable(content, context);
  }

  #parseReservedDirective(content: string, context: DirectiveContext): PathOperation | null {
    const keyword = content.match(/^@[^\s=:]+/)?.[0] ?? content;
    const definition = DIRECTIVE_DEFINITIONS.get(keyword);
    if (!definition) return null;

    const suffix = content.slice(keyword.length);
    this.#requirePathList(keyword, suffix, context);

    const whitespaceLength = this.#getLeadingWhitespaceLength(suffix);
    const pathList = suffix.trimStart();
    const listOffset = keyword.length + whitespaceLength;

    const type = definition.type;
    const base64 = definition.base64;
    const items = this.#splitPathList(pathList, context, listOffset);
    const paths = items.map((item) => this.#parsePath(item, context));
    return { type, keyword, base64, paths };
  }

  #requirePathList(keyword: string, suffix: string, context: DirectiveContext): void {
    if (/^\s/.test(suffix)) return;
    this.#throwSyntaxError(context, keyword.length, 'TURF_MISSING_PATH', `${keyword} requires at least one path.`);
  }

  #splitPathList(source: string, context: DirectiveContext, listOffset: number): PathItem[] {
    const items: PathItem[] = [];
    let itemStart = 0;

    while (itemStart <= source.length) {
      const itemEnd = this.#findPathItemEnd(source, itemStart, context, listOffset);
      items.push(this.#createPathItem(source, itemStart, itemEnd, listOffset));
      if (itemEnd === source.length) break;
      itemStart = itemEnd + 1;
    }

    return items;
  }

  #findPathItemEnd(source: string, itemStart: number, context: DirectiveContext, listOffset: number): number {
    let quote: string | undefined;

    for (let index = itemStart; index < source.length; index += 1) {
      const character = source[index];

      if (character === '\\' && quote) {
        index += 1;
      } else if (character === quote) {
        quote = undefined;
      } else if (!quote && this.#isQuoteCharacter(character)) {
        quote = character;
      } else if (!quote && character === ',') {
        return index;
      }
    }

    if (quote) {
      this.#throwSyntaxError(
        context,
        listOffset + itemStart,
        'TURF_UNCLOSED_QUOTED_PATH',
        'Quoted include path is not closed.'
      );
    }

    return source.length;
  }

  #createPathItem(source: string, start: number, end: number, listOffset: number): PathItem {
    const raw = source.slice(start, end);
    const offset = listOffset + start;
    return { raw, offset };
  }

  #parsePath(item: PathItem, context: DirectiveContext): string {
    const whitespaceLength = this.#getLeadingWhitespaceLength(item.raw);
    const value = item.raw.trim();
    const valueOffset = item.offset + whitespaceLength;

    if (!value) {
      this.#throwSyntaxError(context, item.offset, 'TURF_EMPTY_PATH', 'Include and compile paths cannot be empty.');
    }

    if (this.#isQuoteCharacter(value[0])) {
      return this.#parseQuotedValue(value, context, valueOffset);
    }

    if (Array.from(QUOTE_CHARACTERS).some((quote) => value.includes(quote))) {
      this.#throwSyntaxError(
        context,
        valueOffset,
        'TURF_INVALID_QUOTED_PATH',
        'Quotes must surround the complete path.'
      );
    }

    return value;
  }

  #parseVariable(content: string, context: DirectiveContext): SetOperation | GetOperation {
    const sigil = content[0] as VariableSigil;
    const originalName = this.#parseVariableName(content, context);
    const nameEnd = sigil.length + originalName.length;
    const suffix = content.slice(nameEnd);

    if (suffix === '') return this.#createVariableRead(sigil, originalName, false);
    if (suffix === '?') return this.#createVariableRead(sigil, originalName, true);

    if (suffix.startsWith('?')) {
      this.#throwSyntaxError(
        context,
        nameEnd,
        'TURF_INVALID_OPTIONAL_VARIABLE',
        'Optional marker is only valid on a variable read.'
      );
    }

    const assignment = this.#createVariableAssignmentSource(suffix, nameEnd, context);
    return this.#createVariableAssignment(sigil, originalName, assignment, context);
  }

  #parseVariableName(content: string, context: DirectiveContext): string {
    const match = content.slice(1).match(VARIABLE_NAME_PATTERN);
    if (match) return match[0];
    this.#throwSyntaxError(context, 1, 'TURF_INVALID_VARIABLE_NAME', 'Invalid variable name.');
  }

  #createVariableRead(sigil: VariableSigil, originalName: string, optional: boolean): GetOperation {
    const type = 'get';
    const name = originalName.toLowerCase();
    return { type, sigil, name, originalName, optional };
  }

  #createVariableAssignmentSource(
    suffix: string,
    nameEnd: number,
    context: DirectiveContext
  ): VariableAssignmentSource {
    if (suffix[0] === '=' || suffix[0] === ':') {
      return { rawValue: suffix.slice(1), valueOffset: nameEnd + 1 };
    }

    if (/^\s/.test(suffix)) {
      return this.#createWhitespaceAssignmentSource(suffix, nameEnd);
    }

    this.#throwSyntaxError(context, nameEnd, 'TURF_INVALID_VARIABLE', 'Invalid content after variable name.');
  }

  #createWhitespaceAssignmentSource(suffix: string, nameEnd: number): VariableAssignmentSource {
    const whitespaceLength = this.#getLeadingWhitespaceLength(suffix);
    const trimmedSuffix = suffix.trimStart();
    const hasOperator = trimmedSuffix[0] === '=' || trimmedSuffix[0] === ':';
    const rawValue = hasOperator ? trimmedSuffix.slice(1) : trimmedSuffix;
    const valueOffset = nameEnd + whitespaceLength + (hasOperator ? 1 : 0);
    return { rawValue, valueOffset };
  }

  #createVariableAssignment(
    sigil: VariableSigil,
    originalName: string,
    assignment: VariableAssignmentSource,
    context: DirectiveContext
  ): SetOperation {
    const type = 'set';
    const name = originalName.toLowerCase();
    const parsedValue = this.#parseVariableValue(assignment.rawValue, context, assignment.valueOffset);
    const { value, quoted } = parsedValue;
    return { type, sigil, name, originalName, value, quoted };
  }

  #parseVariableValue(rawValue: string, context: DirectiveContext, relativeOffset: number): ParsedVariableValue {
    const whitespaceLength = this.#getLeadingWhitespaceLength(rawValue);
    const value = rawValue.trim();
    const valueOffset = relativeOffset + whitespaceLength;

    if (!value) {
      this.#throwSyntaxError(
        context,
        relativeOffset,
        'TURF_MISSING_VARIABLE_VALUE',
        'Variable assignment requires a value.'
      );
    }

    if (this.#isQuoteCharacter(value[0])) {
      const parsedValue = this.#parseQuotedValue(value, context, valueOffset);
      return { value: parsedValue, quoted: true };
    }

    const parsedValue = value === 'nil' ? '' : value;
    return { value: parsedValue, quoted: false };
  }

  #parseQuotedValue(value: string, context: DirectiveContext, valueOffset: number): string {
    const openingQuote = value[0];
    let result = '';

    for (let index = 1; index < value.length; ) {
      const character = value[index];

      if (character === '\\') {
        const escaped = value[index + 1];
        const recognized = escaped === '\\' || this.#isQuoteCharacter(escaped);
        result += recognized ? escaped : character;
        index += recognized ? 2 : 1;
        continue;
      }

      if (character === openingQuote) {
        if (index === value.length - 1) return result;
        this.#throwSyntaxError(
          context,
          valueOffset + index + 1,
          'TURF_INVALID_QUOTED_VALUE',
          'Unexpected content after quoted value.'
        );
      }

      result += character;
      index += 1;
    }

    this.#throwSyntaxError(context, valueOffset, 'TURF_UNCLOSED_QUOTED_VALUE', 'Quoted value is not closed.');
  }

  #getLeadingWhitespaceLength(value: string): number {
    return value.length - value.trimStart().length;
  }

  #isQuoteCharacter(character: string | undefined): boolean {
    if (character === undefined) return false;
    return QUOTE_CHARACTERS.has(character);
  }

  #throwSyntaxError(context: DirectiveContext, relativeOffset: number, code: string, message: string): never {
    const file = context.file;
    const offset = context.tokenOffset + relativeOffset;
    const position = TurfScanner.getSourcePosition(context.source, offset);
    const { line, column } = position;
    throw new TurfSyntaxError(message, { code, file, line, column, offset });
  }

  static parse(source: unknown, options?: ScannerOptions): ParsedSource {
    return new TurfParser(TurfScanner.scan(source, options)).parse();
  }
}
