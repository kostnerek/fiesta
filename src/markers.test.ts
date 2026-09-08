import { describe, expect, it } from 'vitest';
import { findLastMarker, findLastStep } from './markers.js';

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

describe('the STEP marker', () => {
  it('reports a stage without ending the turn', () => {
    expect(findLastStep('working\n@@FIESTA:STEP testing\nmore work')).toBe('testing');
  });

  it('takes the last one, because a turn passes through several stages', () => {
    expect(findLastStep('@@FIESTA:STEP building\n@@FIESTA:STEP qa\n')).toBe('qa');
  });

  it('survives the box drawing herdr puts down the left of a pane', () => {
    expect(findLastStep('│ @@FIESTA:STEP qa')).toBe('qa');
  });

  it('is absent when the agent has not reported one', () => {
    expect(findLastStep('just some output')).toBeNull();
  });

  it('is not confused with the markers that end a turn', () => {
    expect(findLastStep('@@FIESTA:DONE https://pr/1')).toBeNull();
    expect(findLastMarker('@@FIESTA:STEP qa')).toBeNull();
  });
});
