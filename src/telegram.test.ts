import { describe, expect, it, vi } from 'vitest';
import { extractShortLink, formatEscalation, TelegramClient } from './telegram.js';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('formatEscalation', () => {
  it('puts the shortLink where extractShortLink can find it again', () => {
    const text = formatEscalation({
      shortLink: 'aBcD1234',
      title: 'Add HELLO file',
      marker: { kind: 'ASK', text: 'Which provider?' },
    });
    expect(extractShortLink(text)).toBe('aBcD1234');
    expect(text).toContain('Which provider?');
  });

  it('asks for a reply only for ASK', () => {
    const ask = formatEscalation({
      shortLink: 'a1',
      title: 't',
      marker: { kind: 'ASK', text: 'q' },
    });
    const fail = formatEscalation({
      shortLink: 'a1',
      title: 't',
      marker: { kind: 'FAIL', text: 'tests red' },
    });
    expect(ask).toMatch(/odpowiedz/i);
    expect(fail).not.toMatch(/odpowiedz/i);
  });
});

describe('extractShortLink', () => {
  it('returns null when the message carries no shortLink', () => {
    expect(extractShortLink('just chatting')).toBeNull();
  });
});

describe('TelegramClient', () => {
  it('normalises an update, keeping the replied-to text', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        result: [
          {
            update_id: 11,
            message: {
              chat: { id: 42 },
              text: 'use provider X',
              reply_to_message: { text: '🤖 [aBcD1234] Add HELLO file' },
            },
          },
        ],
      }),
    );
    const updates = await new TelegramClient('token', fetchMock).getUpdates(10);
    expect(updates).toEqual([
      {
        updateId: 11,
        chatId: '42',
        text: 'use provider X',
        replyToText: '🤖 [aBcD1234] Add HELLO file',
      },
    ]);
  });

  it('keeps a plain message as an update with a null replyToText', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ ok: true, result: [{ update_id: 12, message: { chat: { id: 42 }, text: 'hi' } }] }),
    );
    const updates = await new TelegramClient('token', fetchMock).getUpdates(10);
    expect(updates[0]!.replyToText).toBeNull();
  });

  it('sends the message in a POST body, never in the query string', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, result: {} }));
    const text = 'x'.repeat(3000);

    await new TelegramClient('secret-bot-token', fetchMock).send('42', text);

    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://api.telegram.org/botsecret-bot-token/sendMessage');
    expect(url).not.toContain('chat_id');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ chat_id: '42', text });
  });

  it('asks getUpdates for the offset it was given', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, result: [] }));

    await new TelegramClient('token', fetchMock).getUpdates(11);

    const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ offset: 11, timeout: 0 });
  });

  it('reads the bot username from getMe', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: true, result: { username: 'fiesta_bot' } }));

    await expect(new TelegramClient('token', fetchMock).getMe()).resolves.toEqual({
      username: 'fiesta_bot',
    });
  });

  it('throws with Telegram\'s own description when the API answers ok: false', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: false, description: 'chat not found' }));

    await expect(new TelegramClient('token', fetchMock).send('42', 'hi')).rejects.toThrow(
      /sendMessage rejected: chat not found/,
    );
  });

  it('throws on a non-2xx response', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('too many requests', { status: 429 }));

    await expect(new TelegramClient('token', fetchMock).send('42', 'hi')).rejects.toThrow(
      /sendMessage failed: 429/,
    );
  });
});
