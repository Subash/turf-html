export interface OutputPiece {
  text: string;
  file?: string;
}

export interface OutputSource {
  file: string;
  start: number;
  end: number;
}

export function getOutputText(pieces: OutputPiece[]): string {
  return pieces.map((piece) => piece.text).join('');
}

export function sliceOutput(pieces: OutputPiece[], start: number, end: number): OutputPiece[] {
  const sliced: OutputPiece[] = [];
  let offset = 0;

  for (const piece of pieces) {
    const pieceStart = Math.max(start - offset, 0);
    const pieceEnd = Math.min(end - offset, piece.text.length);
    if (pieceStart < pieceEnd) sliced.push({ ...piece, text: piece.text.slice(pieceStart, pieceEnd) });
    offset += piece.text.length;
  }

  return sliced;
}

export function getOutputSources(pieces: OutputPiece[]): OutputSource[] {
  const sources: OutputSource[] = [];
  let offset = 0;

  for (const piece of pieces) {
    const start = offset;
    offset += piece.text.length;
    if (piece.file === undefined || piece.text.length === 0) continue;

    const previous = sources.at(-1);
    if (previous?.file === piece.file && previous.end === start) previous.end = offset;
    else sources.push({ file: piece.file, start, end: offset });
  }

  return sources;
}
