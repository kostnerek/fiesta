import { describe, expect, it, vi } from 'vitest';
import { ProgressTracker } from './progress-tracker.js';

function build() {
  const sent: string[] = [];
  const edited: { id: number; text: string }[] = [];
  const telegram = {
    sendTracked: vi.fn(async (_chat: string, text: string) => {
      sent.push(text);
      return 100 + sent.length;
    }),
    edit: vi.fn(async (_chat: string, id: number, text: string) => {
      edited.push({ id, text });
    }),
  };
  return { tracker: new ProgressTracker(telegram, '1'), telegram, sent, edited };
}

describe('ProgressTracker', () => {
  it('sends one message the first time a ticket is seen', async () => {
    const { tracker, telegram, sent } = build();
    await tracker.set('aBcD1234', 'Add a thing', 'claimed');

    expect(telegram.sendTracked).toHaveBeenCalledOnce();
    expect(sent[0]).toContain('█░░░░░ 1/6');
  });

  it('edits that message rather than sending a second one', async () => {
    const { tracker, telegram, edited } = build();
    await tracker.set('aBcD1234', 'Add a thing', 'claimed');
    await tracker.set('aBcD1234', 'Add a thing', 'testing');

    expect(telegram.sendTracked).toHaveBeenCalledOnce();
    expect(edited.at(-1)?.text).toContain('███░░░ 3/6');
  });

  it('says nothing when the stage has not moved, so the chat stays quiet', async () => {
    const { tracker, telegram } = build();
    await tracker.set('aBcD1234', 'Add a thing', 'testing');
    await tracker.set('aBcD1234', 'Add a thing', 'testing');

    expect(telegram.edit).not.toHaveBeenCalled();
  });

  it('never rewinds, so a stale pane read cannot undo progress', async () => {
    const { tracker, edited } = build();
    await tracker.set('aBcD1234', 'Add a thing', 'qa');
    await tracker.set('aBcD1234', 'Add a thing', 'building');

    expect(edited).toHaveLength(0);
  });

  it('keeps one bar per ticket', async () => {
    const { tracker, telegram } = build();
    await tracker.set('aaaa1111', 'One', 'claimed');
    await tracker.set('bbbb2222', 'Two', 'claimed');

    expect(telegram.sendTracked).toHaveBeenCalledTimes(2);
  });

  it('forgets a ticket once it is merged, so the next card starts a fresh bar', async () => {
    const { tracker, telegram } = build();
    await tracker.set('aBcD1234', 'Add a thing', 'merged');
    await tracker.set('aBcD1234', 'Add a thing', 'claimed');

    expect(telegram.sendTracked).toHaveBeenCalledTimes(2);
  });

  it('carries on when Telegram is down rather than failing the tick', async () => {
    const { tracker, telegram } = build();
    telegram.sendTracked.mockRejectedValueOnce(new Error('telegram is down'));

    await expect(tracker.set('aBcD1234', 'Add a thing', 'claimed')).resolves.toBeUndefined();
  });
});
