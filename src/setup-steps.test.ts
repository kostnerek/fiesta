import { describe, expect, it, vi } from 'vitest';
import { askUntilValid, detectChatId, ensureColumns, renderEnvFile } from './setup-steps.js';

describe('ensureColumns', () => {
  it('creates only the missing columns and returns every id', async () => {
    const trello = {
      lists: vi.fn().mockResolvedValue([
        { id: 'l-ready', name: 'Ready' },
        { id: 'l-done', name: 'Done' },
      ]),
      createList: vi.fn(async (_boardId: string, name: string) => ({ id: `new-${name}`, name })),
    };

    const ids = await ensureColumns(trello as never, 'board-1');

    expect(ids.ready).toBe('l-ready');
    expect(ids.done).toBe('l-done');
    expect(ids.inProgress).toBe('new-In Progress');
    expect(trello.createList).toHaveBeenCalledTimes(4);
  });

  it('creates nothing on a second run', async () => {
    const existing = [
      { id: '1', name: 'Backlog' },
      { id: '2', name: 'Ready' },
      { id: '3', name: 'In Progress' },
      { id: '4', name: 'Blocked' },
      { id: '5', name: 'Review' },
      { id: '6', name: 'Done' },
    ];
    const trello = { lists: vi.fn().mockResolvedValue(existing), createList: vi.fn() };

    await ensureColumns(trello as never, 'board-1');

    expect(trello.createList).not.toHaveBeenCalled();
  });
});

describe('detectChatId', () => {
  it('returns the chat id of the first message that arrives', async () => {
    const telegram = {
      getUpdates: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ updateId: 5, chatId: '42', text: 'hi', replyToText: null }]),
    };
    await expect(detectChatId(telegram as never, 0, { attempts: 5, delayMs: 0 })).resolves.toBe('42');
  });

  it('gives up after the configured attempts', async () => {
    const telegram = { getUpdates: vi.fn().mockResolvedValue([]) };
    await expect(detectChatId(telegram as never, 0, { attempts: 2, delayMs: 0 })).rejects.toThrow(
      /no message/i,
    );
  });
});

describe('renderEnvFile', () => {
  it('quotes every value so tokens with special characters survive', () => {
    const env = renderEnvFile({ TRELLO_TOKEN: 'ab#cd', GITHUB_OWNER: 'kostnerek' });
    expect(env).toContain('TRELLO_TOKEN="ab#cd"');
    expect(env.trim().split('\n')).toHaveLength(2);
  });

  it('escapes embedded double quotes so the output stays structurally valid', () => {
    const env = renderEnvFile({ TRELLO_TOKEN: 'ab"cd' });
    expect(env).toContain('TRELLO_TOKEN="ab\\"cd"');
  });
});

describe('askUntilValid', () => {
  it('returns as soon as the value verifies', async () => {
    const ask = vi.fn().mockResolvedValue('good');
    const result = await askUntilValid({
      attempts: 3,
      ask,
      verify: async (value: string) => `hello ${value}`,
      onError: () => undefined,
    });

    expect(result).toEqual({ value: 'good', description: 'hello good' });
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('asks again after a rejected credential, reporting why', async () => {
    const ask = vi.fn().mockResolvedValueOnce('bad').mockResolvedValue('good');
    const errors: string[] = [];

    const result = await askUntilValid({
      attempts: 3,
      ask,
      verify: async (value: string) => {
        if (value === 'bad') {
          throw new Error('401 invalid key');
        }
        return 'ok';
      },
      onError: (message) => errors.push(message),
    });

    expect(result.value).toBe('good');
    expect(ask).toHaveBeenCalledTimes(2);
    expect(errors).toEqual(['401 invalid key']);
  });

  it('gives up after the attempt limit rather than looping forever', async () => {
    const ask = vi.fn().mockResolvedValue('bad');

    await expect(
      askUntilValid({
        attempts: 2,
        ask,
        verify: async () => {
          throw new Error('401 invalid token');
        },
        onError: () => undefined,
      }),
    ).rejects.toThrow(/Giving up after 2 attempts.*401 invalid token/);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('tells the caller how many attempts remain', async () => {
    const remaining: number[] = [];
    await expect(
      askUntilValid({
        attempts: 3,
        ask: async () => 'bad',
        verify: async () => {
          throw new Error('nope');
        },
        onError: (_message, attemptsLeft) => remaining.push(attemptsLeft),
      }),
    ).rejects.toThrow();
    expect(remaining).toEqual([2, 1, 0]);
  });
});
