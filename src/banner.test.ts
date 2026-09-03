import { describe, expect, it } from 'vitest';
import { banner, startupLines } from './banner.js';
import type { Config } from './config.js';

function makeConfig(overrides: Partial<Config['limits']> = {}): Config {
  return {
    trello: { key: 'k', token: 't', boardId: 'board-1', lists: {} as Config['trello']['lists'] },
    telegram: { botToken: 'tg', chatId: '1' },
    github: { token: 'gh', owner: 'kostnerek' },
    paths: { root: '/mnt/user/appdata/fiesta', claudeCredentials: '/root/.claude' },
    limits: { maxActive: 1, ticketTimeoutMs: 3_600_000, pollIntervalMs: 30_000, ...overrides },
  };
}

describe('banner', () => {
  it('is a block of equal-width lines, so it cannot render ragged', () => {
    const widths = new Set(banner().map((line) => line.length));
    expect(widths.size).toBe(1);
  });

  it('cannot be mutated by a caller', () => {
    banner().push('tampered');
    expect(banner()).toHaveLength(5);
  });
});

describe('startupLines', () => {
  it('names the board, the projects and where data lives', () => {
    const lines = startupLines({
      config: makeConfig(),
      projects: ['tsoft', 'fiesta'],
      version: '1.0.0',
    }).join('\n');

    expect(lines).toContain('board      board-1');
    expect(lines).toContain('projects   tsoft, fiesta');
    expect(lines).toContain('data root  /mnt/user/appdata/fiesta');
  });

  it('says how to add a project when there are none', () => {
    const lines = startupLines({ config: makeConfig(), projects: [], version: '1.0.0' }).join('\n');
    expect(lines).toMatch(/none yet — add one with "fiesta project"/);
  });

  it('reports the poll interval in seconds and the active limit', () => {
    const lines = startupLines({
      config: makeConfig({ pollIntervalMs: 45_000, maxActive: 2 }),
      projects: [],
      version: '1.0.0',
    }).join('\n');

    expect(lines).toContain('Ready every 45s, 2 tickets at a time');
  });

  it('says "1 ticket", not "1 tickets"', () => {
    const lines = startupLines({ config: makeConfig(), projects: [], version: '1.0.0' }).join('\n');
    expect(lines).toContain('1 ticket at a time');
  });
});

describe('startupLines without a version', () => {
  it('prints a bare name rather than a trailing space', () => {
    const lines = startupLines({ config: makeConfig(), projects: [], version: '' });
    expect(lines[0]).toBe('fiesta');
  });
});
