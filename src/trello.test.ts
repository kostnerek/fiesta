import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TrelloClient } from './trello.js';

function makeClient(fetchImpl: typeof fetch) {
  return new TrelloClient({ key: 'k', token: 't' }, fetchImpl);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('TrelloClient', () => {
  beforeEach(() => vi.clearAllMocks());

  it('appends credentials to every request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
    await makeClient(fetchMock).cardsInList('list-1');
    const url = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(url.pathname).toBe('/1/lists/list-1/cards');
    expect(url.searchParams.get('key')).toBe('k');
    expect(url.searchParams.get('token')).toBe('t');
  });

  it('moves a card with a PUT', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    await makeClient(fetchMock).moveCard('card-1', 'list-2');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(new URL(url as string).searchParams.get('idList')).toBe('list-2');
    expect((init as RequestInit).method).toBe('PUT');
  });

  it('throws with the response body when the API rejects the call', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('invalid token', { status: 401 }));
    await expect(makeClient(fetchMock).me()).rejects.toThrow(/401.*invalid token/s);
  });
});

describe('TrelloClient.cardsInList', () => {
  it('asks for labels as a card field, since a card without them has no project', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
    await makeClient(fetchMock).cardsInList('list-1');

    const fields = new URL(fetchMock.mock.calls[0]![0] as string).searchParams.get('fields');
    expect(fields?.split(',')).toContain('labels');
  });
});
