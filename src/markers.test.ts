import { describe, expect, it } from 'vitest';
import { findLastMarker } from './markers.js';

describe('findLastMarker', () => {
  it('returns null when the output has no marker', () => {
    expect(findLastMarker('running tests...\nall green\n')).toBeNull();
  });

  it('extracts the marker kind and its text', () => {
    const output = 'work\n@@FIESTA:ASK Which payment provider should I wire up?\n';
    expect(findLastMarker(output)).toEqual({
      kind: 'ASK',
      text: 'Which payment provider should I wire up?',
    });
  });

  it('returns the last marker when several are present', () => {
    const output = '@@FIESTA:ASK first question\nanswer given\n@@FIESTA:DONE https://pr/1\n';
    expect(findLastMarker(output)).toEqual({ kind: 'DONE', text: 'https://pr/1' });
  });

  it('ignores a marker quoted inside the prompt echo', () => {
    const output = 'End your turn with "@@FIESTA:ASK <question>" when blocked.\n';
    expect(findLastMarker(output)).toBeNull();
  });

  it('accepts a marker with no trailing text', () => {
    expect(findLastMarker('@@FIESTA:FAIL\n')).toEqual({ kind: 'FAIL', text: '' });
  });

  it('matches a marker line even when the pane output uses CRLF endings', () => {
    const output = 'work\r\n@@FIESTA:ASK Which payment provider should I wire up?\r\n';
    expect(findLastMarker(output)).toEqual({
      kind: 'ASK',
      text: 'Which payment provider should I wire up?',
    });
  });
});

describe('findLastMarker against a rendered TUI', () => {
  it.each([
    ['  @@FIESTA:DONE https://pr/7', 'https://pr/7'],
    ['│ @@FIESTA:DONE https://pr/7', 'https://pr/7'],
    ['> @@FIESTA:DONE https://pr/7', 'https://pr/7'],
    ['\t@@FIESTA:DONE https://pr/7', 'https://pr/7'],
  ])('reads a marker indented by the interface: %s', (line, text) => {
    expect(findLastMarker(`working...\n${line}\n`)).toEqual({ kind: 'DONE', text });
  });

  it('still ignores a marker quoted mid-sentence', () => {
    expect(findLastMarker('End your turn with "@@FIESTA:ASK <question>".\n')).toBeNull();
  });
});
