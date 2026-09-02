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

  it('drops updates that are not replies', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ ok: true, result: [{ update_id: 12, message: { chat: { id: 42 }, text: 'hi' } }] }),
    );
    const updates = await new TelegramClient('token', fetchMock).getUpdates(10);
    expect(updates[0]!.replyToText).toBeNull();
  });
});
