import type { Config } from './config.js';
import type { HerdrClient } from './herdr.js';
import { findLastMarker, type Marker } from './markers.js';
import type { Ticket } from './ticket.js';
import { extractShortLink, formatEscalation, type TelegramClient } from './telegram.js';
import type { TrelloClient } from './trello.js';

export type Outcome = 'running' | 'blocked' | 'review';

export type ActiveTicket = { ticket: Ticket; paneId: string };

export type InspectOptions = { since: number | null; lastMarker: Marker | null };

export type InspectResult = { outcome: Outcome; marker: Marker | null };

function isSameMarker(marker: Marker, previous: Marker | null): boolean {
  return previous !== null && previous.kind === marker.kind && previous.text === marker.text;
}

export class Escalator {
  private telegramOffset = 0;

  constructor(
    private readonly deps: {
      herdr: HerdrClient;
      telegram: TelegramClient;
      trello: TrelloClient;
      config: Config;
    },
  ) {}

  async inspect(ticket: Ticket, paneId: string, options: InspectOptions): Promise<InspectResult> {
    const { herdr, telegram, trello, config } = this.deps;
    const marker = findLastMarker(await herdr.readPane(paneId));

    if (marker && !isSameMarker(marker, options.lastMarker)) {
      const list = marker.kind === 'DONE' ? config.trello.lists.review : config.trello.lists.blocked;
      await trello.moveCard(ticket.cardId, list);
      await trello.addComment(ticket.cardId, `🤖 ${marker.kind}: ${marker.text}`);
      await telegram.send(
        config.telegram.chatId,
        formatEscalation({ shortLink: ticket.shortLink, title: ticket.title, marker }),
      );
      return { outcome: marker.kind === 'DONE' ? 'review' : 'blocked', marker };
    }

    if (options.since === null) {
      return { outcome: 'running', marker: null };
    }

    const status = await herdr.paneStatus(paneId);
    const silentFor = Date.now() - options.since;
    if (status !== 'working' && silentFor > config.limits.ticketTimeoutMs) {
      await trello.moveCard(ticket.cardId, config.trello.lists.blocked);
      await trello.addComment(
        ticket.cardId,
        `🤖 Agent timed out after ${Math.round(silentFor / 60000)} minutes without a marker.`,
      );
      await telegram.send(
        config.telegram.chatId,
        formatEscalation({
          shortLink: ticket.shortLink,
          title: ticket.title,
          marker: { kind: 'FAIL', text: 'timed out with no marker' },
        }),
      );
      return { outcome: 'blocked', marker: null };
    }

    return { outcome: 'running', marker: null };
  }

  async deliverReplies(active: Map<string, ActiveTicket>): Promise<void> {
    const { herdr, telegram, trello, config } = this.deps;
    const updates = await telegram.getUpdates(this.telegramOffset);

    for (const update of updates) {
      const shortLink = update.replyToText ? extractShortLink(update.replyToText) : null;
      try {
        const target = shortLink ? active.get(shortLink) : undefined;
        if (target) {
          await herdr.sendText(target.paneId, update.text);
          await trello.moveCard(target.ticket.cardId, config.trello.lists.inProgress);
          await trello.addComment(target.ticket.cardId, `🤖 Answer delivered: ${update.text}`);
        }
      } catch (error) {
        console.error(
          `Failed to deliver Telegram update ${update.updateId} for shortLink ${shortLink ?? 'unknown'}:`,
          error,
        );
      } finally {
        this.telegramOffset = update.updateId + 1;
      }
    }
  }
}
