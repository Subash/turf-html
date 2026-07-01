import TurfSyntaxError from './syntax-error.ts';

export interface ScannerOptions {
  file?: string;
}

export interface SourcePosition {
  offset: number;
  line: number;
  column: number;
}

export interface SourceRange {
  start: SourcePosition;
  end: SourcePosition;
}

export interface SourceEnvelope {
  start: number;
  end: number;
}

export interface InlineLayout {
  kind: 'inline';
  indent: '';
  envelope: SourceEnvelope;
}

export interface StandaloneLayout {
  kind: 'standalone';
  indent: string;
  envelope: SourceEnvelope;
}

export type CommentLayout = InlineLayout | StandaloneLayout;

export interface TextSegment {
  type: 'text';
  raw: string;
  range: SourceRange;
}

export interface CommentSegment {
  type: 'comment';
  raw: string;
  content: string;
  range: SourceRange;
  layout: CommentLayout;
}

export type ScannedSegment = TextSegment | CommentSegment;

export interface ScannedSource {
  source: string;
  file?: string;
  segments: ScannedSegment[];
}

interface CommentLine {
  start: number;
  end: number;
  indent: string;
  trailingWhitespace: string;
}

export class TurfScanner {
  static COMMENT_START = '<!--';
  static COMMENT_END = '-->';

  #source: string;
  #file: string | undefined;
  #segments: ScannedSegment[] = [];
  #cursor: number = 0;

  constructor(source: unknown, { file }: ScannerOptions = {}) {
    this.#source = this.#normalizeSource(source);
    this.#file = file;
  }

  #normalizeSource(source: unknown): string {
    if (typeof source !== 'string') {
      throw new TypeError('Turf source must be a string.');
    }

    return source.replace(/\r\n/g, '\n');
  }

  scan(): ScannedSource {
    while (this.#hasSource()) this.#scanNextSegment();
    return { source: this.#source, file: this.#file, segments: this.#segments };
  }

  #hasSource(): boolean {
    return this.#cursor < this.#source.length;
  }

  #scanNextSegment(): void {
    const commentStart = this.#source.indexOf(TurfScanner.COMMENT_START, this.#cursor);

    if (commentStart === -1) {
      this.#addTextSegment(this.#source.length);
      return;
    }

    this.#addTextSegment(commentStart);
    this.#addCommentSegment(commentStart);
  }

  #addTextSegment(end: number): void {
    if (this.#cursor < end) {
      this.#segments.push(this.#createTextSegment(this.#cursor, end));
    }

    this.#cursor = end;
  }

  #createTextSegment(start: number, end: number): TextSegment {
    return {
      type: 'text',
      raw: this.#source.slice(start, end),
      range: this.#createRange(start, end)
    };
  }

  #addCommentSegment(start: number): void {
    const end = this.#findCommentEnd(start);
    this.#segments.push(this.#createCommentSegment(start, end));
    this.#cursor = end;
  }

  #findCommentEnd(start: number): number {
    const contentStart = start + TurfScanner.COMMENT_START.length;
    const closingMarker = this.#source.indexOf(TurfScanner.COMMENT_END, contentStart);

    if (closingMarker === -1) {
      this.#throwSyntaxError('Invalid comment. Comment not closed.', 'TURF_UNCLOSED_COMMENT', start);
    }

    const nestedComment = this.#source.indexOf(TurfScanner.COMMENT_START, contentStart);
    if (nestedComment !== -1 && nestedComment < closingMarker) {
      this.#throwSyntaxError('Invalid comment. Nested comments are not allowed.', 'TURF_NESTED_COMMENT', nestedComment);
    }

    return closingMarker + TurfScanner.COMMENT_END.length;
  }

  #throwSyntaxError(message: string, code: string, offset: number): never {
    const file = this.#file;
    const position = this.#getSourcePosition(offset);
    const { line, column } = position;
    throw new TurfSyntaxError(message, { code, file, line, column, offset });
  }

  #createCommentSegment(start: number, end: number): CommentSegment {
    const type = 'comment' as const;
    const raw = this.#source.slice(start, end);
    const range = this.#createRange(start, end);
    const layout = this.#createCommentLayout(start, end);
    const content = raw.slice(TurfScanner.COMMENT_START.length, -TurfScanner.COMMENT_END.length);
    return { type, raw, content, range, layout };
  }

  #createRange(start: number, end: number): SourceRange {
    return {
      start: this.#getSourcePosition(start),
      end: this.#getSourcePosition(end)
    };
  }

  #getSourcePosition(offset: number): SourcePosition {
    const lineStart = this.#findLineStart(offset);
    const line = this.#source.slice(0, offset).split('\n').length;
    const column = Array.from(this.#source.slice(lineStart, offset)).length + 1;
    return { offset, line, column };
  }

  #createCommentLayout(start: number, end: number): CommentLayout {
    const line = this.#createCommentLine(start, end);
    return this.#isStandaloneLine(line)
      ? this.#createStandaloneLayout(line)
      : { kind: 'inline', indent: '', envelope: { start, end } };
  }

  #createCommentLine(start: number, end: number): CommentLine {
    const lineStart = this.#findLineStart(start);
    const lineEnd = this.#findLineEnd(end);
    const indent = this.#source.slice(lineStart, start);
    const trailingWhitespace = this.#source.slice(end, lineEnd);
    return { start: lineStart, end: lineEnd, indent, trailingWhitespace };
  }

  #isStandaloneLine(line: CommentLine): boolean {
    return this.#isHorizontalWhitespace(line.indent) && this.#isHorizontalWhitespace(line.trailingWhitespace);
  }

  #isHorizontalWhitespace(value: string): boolean {
    return /^[\t ]*$/.test(value);
  }

  #createStandaloneLayout(line: CommentLine): StandaloneLayout {
    const envelopeEnd = line.end < this.#source.length ? line.end + 1 : line.end;
    return {
      kind: 'standalone',
      indent: line.indent,
      envelope: { start: line.start, end: envelopeEnd }
    };
  }

  #findLineStart(offset: number): number {
    return this.#source.lastIndexOf('\n', offset - 1) + 1;
  }

  #findLineEnd(offset: number): number {
    const newline = this.#source.indexOf('\n', offset);
    return newline === -1 ? this.#source.length : newline;
  }

  static scan(source: unknown, options?: ScannerOptions): ScannedSource {
    return new TurfScanner(source, options).scan();
  }

  static normalizeSource(source: unknown): string {
    return new TurfScanner(source).#source;
  }

  static getSourcePosition(source: string, offset: number): SourcePosition {
    const scanner = new TurfScanner(source);
    return scanner.#getSourcePosition(offset);
  }
}
