export interface TurfSyntaxErrorOptions {
  code?: string;
  file?: string;
  line?: number;
  column?: number;
  offset?: number;
  cause?: unknown;
}

export default class TurfSyntaxError extends SyntaxError {
  code: string;
  file: string | undefined;
  line: number | undefined;
  column: number | undefined;
  offset: number | undefined;

  constructor(message: string, { code, file, line, column, offset, cause }: TurfSyntaxErrorOptions = {}) {
    super(message);
    this.name = 'TurfSyntaxError';
    this.code = code || 'TURF_INVALID_SYNTAX';
    this.file = file;
    this.line = line;
    this.column = column;
    this.offset = offset;
    if (cause !== undefined) this.cause = cause;
  }
}
