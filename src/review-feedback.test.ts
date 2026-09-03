import { describe, expect, it } from 'vitest';
import {
  formatFeedback,
  highestCommentId,
  type PrComment,
  unseenComments,
} from './review-feedback.js';

function comment(overrides: Partial<PrComment> = {}): PrComment {
  return { id: 1, author: 'reviewer', body: 'please rename this', path: null, line: null, ...overrides };
}

describe('unseenComments', () => {
  it('returns everything when nothing has been seen yet', () => {
    const comments = [comment({ id: 2 }), comment({ id: 1 })];
    expect(unseenComments({ comments, lastSeenId: null, agentLogin: 'bot' }).map((c) => c.id)).toEqual([
      1, 2,
    ]);
  });

  it('returns only comments newer than the last one handled', () => {
    const comments = [comment({ id: 1 }), comment({ id: 2 }), comment({ id: 3 })];
    expect(unseenComments({ comments, lastSeenId: 1, agentLogin: 'bot' }).map((c) => c.id)).toEqual([
      2, 3,
    ]);
  });

  it('ignores the agent talking to itself', () => {
    const comments = [comment({ id: 1, author: 'bot' }), comment({ id: 2, author: 'reviewer' })];
    expect(unseenComments({ comments, lastSeenId: null, agentLogin: 'bot' }).map((c) => c.id)).toEqual([
      2,
    ]);
  });

  it('ignores an empty comment, which carries no instruction', () => {
    const comments = [comment({ id: 1, body: '   ' })];
    expect(unseenComments({ comments, lastSeenId: null, agentLogin: 'bot' })).toEqual([]);
  });
});

describe('highestCommentId', () => {
  it('is null for no comments, so nothing is marked as handled', () => {
    expect(highestCommentId([])).toBeNull();
  });

  it('is the maximum id regardless of order', () => {
    expect(highestCommentId([comment({ id: 5 }), comment({ id: 12 }), comment({ id: 3 })])).toBe(12);
  });
});

describe('formatFeedback', () => {
  it('names the file and line for an inline comment', () => {
    const text = formatFeedback({
      prUrl: 'https://pr/7',
      comments: [comment({ author: 'ola', body: 'guard this', path: 'src/a.ts', line: 12 })],
    });

    expect(text).toContain('- ola on src/a.ts:12: guard this');
  });

  it('omits the location for a general comment', () => {
    const text = formatFeedback({ prUrl: 'https://pr/7', comments: [comment({ author: 'ola' })] });
    expect(text).toContain('- ola: please rename this');
  });

  it('tells the agent to push to the same branch rather than open another PR', () => {
    const text = formatFeedback({ prUrl: 'https://pr/7', comments: [comment()] });
    expect(text).toMatch(/do not open another pull request/);
    expect(text).toContain('https://pr/7');
  });

  it('offers disagreement as a reply rather than silent compliance', () => {
    const text = formatFeedback({ prUrl: 'https://pr/7', comments: [comment()] });
    expect(text).toMatch(/reply to it on the PR explaining why/);
  });
});
