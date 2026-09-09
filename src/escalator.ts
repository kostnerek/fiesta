import type { Config } from './config.js';
import type { HerdrClient } from './herdr.js';
import { findLastMarker, findLastStep, findPrUrls, type Marker } from './markers.js';
import type { Ticket } from './ticket.js';
import {
  extractShortLink,
  formatEscalation,
  type TelegramClient,
  type TelegramUpdate,
} from './telegram.js';
import type { TrelloClient } from './trello.js';

export type Outcome = 'running' | 'blocked' | 'review';

export type ActiveTicket = { ticket: Ticket; paneId: string };

export type InspectOptions = { since: number | null; lastMarker: Marker | null };

export type InspectResult = { outcome: Outcome; marker: Marker | null; step: string | null };

const TELEGRAM_BACKLOG_PAGE_SIZE = 100;

function isSameMarker(marker: Marker, previous: Marker | null): boolean {
  return previous !== null && previous.kind === marker.kind && previous.text === marker.text;
}

export class Escalator {
  private telegramOffset = 0;
  private telegramPrimed = false;

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
    const pane = await herdr.readPane(paneId);
    const marker = findLastMarker(pane);
    const step = findLastStep(pane);
    const prUrls = findPrUrls(pane);

    if (marker && !isSameMarker(marker, options.lastMarker)) {
      const list = marker.kind === 'DONE' ? config.trello.lists.review : config.trello.lists.blocked;
      await trello.moveCard(ticket.cardId, list);
      const detail =
        marker.kind === 'DONE' && prUrls.length > 0
          ? prUrls.join('\n')
          : marker.text;
      await trello.addComment(ticket.cardId, `🤖 ${marker.kind}: ${detail}`);
      await telegram.send(
        config.telegram.chatId,
        formatEscalation({ shortLink: ticket.shortLink, title: ticket.title, marker, prUrls }),
      );
      return { outcome: marker.kind === 'DONE' ? 'review' : 'blocked', marker, step };
    }

    if (options.since === null) {
      return { outcome: 'running', marker: null, step };
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
      return { outcome: 'blocked', marker: null, step };
    }

    return { outcome: 'running', marker: null, step };
  }

  async deliverReplies(active: Map<string, ActiveTicket>): Promise<void> {
    const { herdr, telegram, trello, config } = this.deps;

    if (!this.telegramPrimed) {
      await this.skipBacklog(active);
      return;
    }

    const updates = await telegram.getUpdates(this.telegramOffset);
    for (const update of updates) {
      const shortLink = update.replyToText ? extractShortLink(update.replyToText) : null;
      try {
        const target =
          shortLink && update.chatId === config.telegram.chatId ? active.get(shortLink) : undefined;
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

  private async skipBacklog(active: Map<string, ActiveTicket>): Promise<void> {
    const { telegram, trello } = this.deps;

    let page: TelegramUpdate[];
    do {
      page = await telegram.getUpdates(this.telegramOffset);
      await this.skipBacklogPage(page, active, trello);
    } while (page.length === TELEGRAM_BACKLOG_PAGE_SIZE);

    this.telegramPrimed = true;
  }

  private async skipBacklogPage(
    updates: TelegramUpdate[],
    active: Map<string, ActiveTicket>,
    trello: TrelloClient,
  ): Promise<void> {
    for (const update of updates) {
      this.telegramOffset = Math.max(this.telegramOffset, update.updateId + 1);
      const shortLink = update.replyToText ? extractShortLink(update.replyToText) : null;
      const target = shortLink ? active.get(shortLink) : undefined;
      console.warn(
        `[fiesta] skipping Telegram update ${update.updateId} that predates this run` +
          (shortLink ? ` (reply to ${shortLink})` : ''),
      );
      if (!target) {
        continue;
      }
      try {
        await trello.addComment(
          target.ticket.cardId,
          '🤖 A Telegram reply arrived while Fiesta was down and was not delivered. Please resend it.',
        );
      } catch (error) {
        console.error(`Failed to flag a skipped Telegram reply for ${shortLink}:`, error);
      }
    }
  }
}
