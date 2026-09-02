export type MarkerKind = 'ASK' | 'DONE' | 'FAIL';

export type Marker = { kind: MarkerKind; text: string };

const MARKER_LINE = /^@@FIESTA:(ASK|DONE|FAIL)[ \t]*(.*)$/;

export function findLastMarker(paneOutput: string): Marker | null {
  const lines = paneOutput.replace(/\r\n/g, '\n').split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = MARKER_LINE.exec(lines[index] ?? '');
    if (match) {
      return { kind: match[1] as MarkerKind, text: (match[2] ?? '').trim() };
    }
  }
  return null;
}
