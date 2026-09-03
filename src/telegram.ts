import type { Marker } from './markers.js';

export type TelegramUpdate = {
  updateId: number;
  chatId: string;
  text: string;
  replyToText: string | null;
};

const SHORT_LINK = /\[([A-Za-z0-9]{6,})\]/;

export function extractShortLink(text: string): string | null {
  return SHORT_LINK.exec(text)?.[1] ?? null;
}

export function formatEscalation(params: {
  shortLink: string;
  title: string;
  marker: Marker;
}): string {
  const header = `🤖 [${params.shortLink}] ${params.title}`;
  if (params.marker.kind === 'ASK') {
    return `${header}\n\n❓ ${params.marker.text}\n\nOdpowiedz na tę wiadomość, żeby odblokować agenta.`;
  }
  if (params.marker.kind === 'FAIL') {
    return `${header}\n\n🛑 Zatrzymany: ${params.marker.text}`;
  }
  return `${header}\n\n✅ Draft PR: ${params.marker.text}`;
}

export class TelegramClient {
  constructor(
    private readonly botToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request<T>(method: string, params: Record<string, string | number>): Promise<T> {
    const response = await this.fetchImpl(`https://api.telegram.org/bot${this.botToken}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
    });
    if (!response.ok) {
      throw new Error(`Telegram ${method} failed: ${response.status} ${await response.text()}`);
    }
    const payload = (await response.json()) as { ok: boolean; result: T; description?: string };
    if (!payload.ok) {
      throw new Error(`Telegram ${method} rejected: ${payload.description ?? 'unknown error'}`);
    }
    return payload.result;
  }

  getMe(): Promise<{ username: string }> {
    return this.request('getMe', {});
  }

  async send(chatId: string, text: string): Promise<void> {
    await this.request('sendMessage', { chat_id: chatId, text });
  }

  async getUpdates(offset: number): Promise<TelegramUpdate[]> {
    const raw = await this.request<
      { update_id: number; message?: { chat: { id: number }; text?: string; reply_to_message?: { text?: string } } }[]
    >('getUpdates', { offset, timeout: 0 });

    return raw
      .filter((update) => update.message?.text)
      .map((update) => ({
        updateId: update.update_id,
        chatId: String(update.message!.chat.id),
        text: update.message!.text!,
        replyToText: update.message!.reply_to_message?.text ?? null,
      }));
  }
}
