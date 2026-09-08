import { describe, expect, it } from 'vitest';
import { formatProgress, nextStage, STAGES, type Stage } from './progress.js';

describe('the stage list', () => {
  it('runs in the order a ticket actually happens', () => {
    expect(STAGES).toEqual(['claimed', 'building', 'testing', 'qa', 'review', 'merged']);
  });
});

describe('formatProgress', () => {
  function bar(stage: Stage): string {
    return formatProgress({ shortLink: 'aBcD1234', title: 'Add a thing', stage });
  }

  it('fills one cell per stage reached', () => {
    expect(bar('claimed')).toContain('█░░░░░ 1/6');
    expect(bar('qa')).toContain('████░░ 4/6');
    expect(bar('merged')).toContain('██████ 6/6');
  });

  it('names the stage in words, not only as a bar', () => {
    expect(bar('testing')).toMatch(/testy/i);
    expect(bar('qa')).toMatch(/qa/i);
  });

  it('carries the card and the title, so several tickets stay distinguishable', () => {
    expect(bar('claimed')).toContain('aBcD1234');
    expect(bar('claimed')).toContain('Add a thing');
  });

  it('shows a blocked ticket as stopped rather than as progress', () => {
    const text = formatProgress({
      shortLink: 'aBcD1234',
      title: 'Add a thing',
      stage: 'qa',
      blocked: 'needs a decision',
    });

    expect(text).toMatch(/needs a decision/);
    expect(text).not.toContain('████░░');
  });
});

describe('nextStage', () => {
  it('moves forward', () => {
    expect(nextStage('claimed', 'testing')).toBe('testing');
  });

  it('never moves backward, so a late pane read cannot rewind the bar', () => {
    expect(nextStage('qa', 'building')).toBe('qa');
  });

  it('keeps the current stage when the new one is not a stage at all', () => {
    expect(nextStage('qa', 'nonsense')).toBe('qa');
  });
});
