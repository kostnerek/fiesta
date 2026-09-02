import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const complete = {
  TRELLO_API_KEY: 'k',
  TRELLO_TOKEN: 't',
  TRELLO_BOARD_ID: 'b',
  TRELLO_LIST_BACKLOG: 'l1',
  TRELLO_LIST_READY: 'l2',
  TRELLO_LIST_IN_PROGRESS: 'l3',
  TRELLO_LIST_BLOCKED: 'l4',
  TRELLO_LIST_REVIEW: 'l5',
  TRELLO_LIST_DONE: 'l6',
  TELEGRAM_BOT_TOKEN: 'tg',
  TELEGRAM_CHAT_ID: '123',
  GITHUB_TOKEN: 'gh',
  GITHUB_OWNER: 'kostnerek',
  FIESTA_ROOT: '/tmp/fiesta',
  CLAUDE_CREDENTIALS_PATH: '/home/x/.claude',
};

describe('loadConfig', () => {
  it('maps every list id onto a named column', () => {
    const config = loadConfig(complete);
    expect(config.trello.lists.ready).toBe('l2');
    expect(config.trello.lists.inProgress).toBe('l3');
  });

  it('applies defaults for optional limits', () => {
    const config = loadConfig(complete);
    expect(config.limits.maxActive).toBe(1);
    expect(config.limits.ticketTimeoutMs).toBe(60 * 60 * 1000);
    expect(config.limits.pollIntervalMs).toBe(30 * 1000);
  });

  it('names every missing variable in one error', () => {
    expect(() => loadConfig({ TRELLO_API_KEY: 'k' })).toThrowError(
      /TRELLO_TOKEN.*TELEGRAM_BOT_TOKEN/s,
    );
  });
});
