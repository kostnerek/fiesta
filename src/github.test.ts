import { describe, expect, it, vi } from 'vitest';
import { GitHubClient } from './github.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('GitHubClient', () => {
  it('finds the pull request for a branch without stored state', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse([{ number: 7, html_url: 'https://pr/7', merged_at: '2026-09-02T10:00:00Z' }]));
    const client = new GitHubClient({ token: 'gh', owner: 'kostnerek' }, fetchMock);

    const pr = await client.findPrByBranch('kostnerek', 'demo', 'fiesta/aBcD1234-add-hello-file');

    expect(pr).toEqual({ number: 7, url: 'https://pr/7', merged: true });
    const url = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(url.searchParams.get('head')).toBe('kostnerek:fiesta/aBcD1234-add-hello-file');
    expect(url.searchParams.get('state')).toBe('all');
  });

  it('returns null when the branch has no pull request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
    const client = new GitHubClient({ token: 'gh', owner: 'kostnerek' }, fetchMock);
    await expect(client.findPrByBranch('kostnerek', 'demo', 'nope')).resolves.toBeNull();
  });
});

describe('tokenScopes', () => {
  it('reads the scopes GitHub reports for the token', async () => {
    const fetchImpl = (async () =>
      new Response('{"login":"kostnerek"}', {
        status: 200,
        headers: { 'x-oauth-scopes': 'repo, read:packages' },
      })) as unknown as typeof fetch;

    const client = new GitHubClient({ token: 't', owner: 'o' }, fetchImpl);
    await expect(client.tokenScopes()).resolves.toEqual(['repo', 'read:packages']);
  });

  it('is empty for a token GitHub reports no scopes for', async () => {
    const fetchImpl = (async () =>
      new Response('{"login":"kostnerek"}', { status: 200 })) as unknown as typeof fetch;

    const client = new GitHubClient({ token: 't', owner: 'o' }, fetchImpl);
    await expect(client.tokenScopes()).resolves.toEqual([]);
  });
});
