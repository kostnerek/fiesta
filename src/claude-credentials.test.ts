import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assessCredentials, checkCredentials, REFRESH_MARGIN_MS } from './claude-credentials.js';

const NOW = 1_700_000_000_000;

function stored(oauth: Record<string, unknown>): string {
  return JSON.stringify({ claudeAiOauth: oauth });
}

describe('assessCredentials', () => {
  it('accepts an access token with time left on it', () => {
    const raw = stored({ expiresAt: NOW + 60 * 60 * 1000 });
    expect(assessCredentials(raw, NOW)).toEqual({ usable: true });
  });

  it('treats a token expiring within the refresh margin as needing the refresh token', () => {
    const raw = stored({ expiresAt: NOW + REFRESH_MARGIN_MS - 1, refreshToken: 'r' });
    expect(assessCredentials(raw, NOW)).toEqual({ usable: true });
  });

  it('accepts an expired access token when the refresh token is still valid', () => {
    const raw = stored({
      expiresAt: NOW - 1,
      refreshToken: 'r',
      refreshTokenExpiresAt: NOW + 86_400_000,
    });
    expect(assessCredentials(raw, NOW)).toEqual({ usable: true });
  });

  it('rejects an expired access token with no refresh token', () => {
    const result = assessCredentials(stored({ expiresAt: NOW - 1 }), NOW);
    expect(result).toEqual({ usable: false, reason: expect.stringMatching(/no refresh token/) });
  });

  it('rejects when both tokens have expired', () => {
    const raw = stored({
      expiresAt: NOW - 2,
      refreshToken: 'r',
      refreshTokenExpiresAt: NOW - 1,
    });
    expect(result(raw)).toMatch(/both the access token and the refresh token have expired/);
  });

  it('rejects a file that is not JSON', () => {
    expect(result('not json')).toMatch(/not valid JSON/);
  });

  it('rejects a file with no oauth section', () => {
    expect(result('{}')).toMatch(/no claudeAiOauth section/);
  });

  function result(raw: string): string {
    const state = assessCredentials(raw, NOW);
    return state.usable ? '' : state.reason;
  }
});

describe('checkCredentials', () => {
  it('reports a missing file by path rather than throwing', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'fiesta-creds-')), 'absent.json');
    const state = await checkCredentials(path, NOW);
    expect(state).toEqual({ usable: false, reason: `no credentials file at ${path}` });
  });

  it('reads a real file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fiesta-creds-'));
    const path = join(dir, '.credentials.json');
    await writeFile(path, stored({ expiresAt: NOW + 3_600_000 }));
    await expect(checkCredentials(path, NOW)).resolves.toEqual({ usable: true });
  });
});
