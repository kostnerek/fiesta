import type { Config } from './config.js';
import type { HerdrClient } from './herdr.js';
import { findLastMarker } from './markers.js';
import type { Ticket } from './ticket.js';
import { extractShortLink, formatEscalation, type TelegramClient } from './telegram.js';
import type { TrelloClient } from './trello.js';

export type Outcome = 'running' | 'blocked' | 'review';

export type ActiveTicket = { ticket: Ticket; paneId: string };

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

  async inspect(ticket: Ticket, paneId: string, lastActivityAt: number): Promise<Outcome> {
    const { herdr, telegram, trello, config } = this.deps;
    const marker = findLastMarker(await herdr.readPane(paneId));

    if (marker) {
      const list = marker.kind === 'DONE' ? config.trello.lists.review : config.trello.lists.blocked;
      await trello.moveCard(ticket.cardId, list);
      await trello.addComment(ticket.cardId, `🤖 ${marker.kind}: ${marker.text}`);
      await telegram.send(
        config.telegram.chatId,
        formatEscalation({ shortLink: ticket.shortLink, title: ticket.title, marker }),
      );
      return marker.kind === 'DONE' ? 'review' : 'blocked';
    }

    const status = await herdr.paneStatus(paneId);
    const silentFor = Date.now() - lastActivityAt;
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
      return 'blocked';
    }

    return 'running';
  }

  async deliverReplies(active: Map<string, ActiveTicket>): Promise<void> {
    const { herdr, telegram, trello, config } = this.deps;
    const updates = await telegram.getUpdates(this.telegramOffset);

    for (const update of updates) {
      this.telegramOffset = update.updateId + 1;
      if (!update.replyToText) {
        continue;
      }
      const shortLink = extractShortLink(update.replyToText);
      const target = shortLink ? active.get(shortLink) : undefined;
      if (!target) {
        continue;
      }
      await herdr.sendText(target.paneId, update.text);
      await trello.moveCard(target.ticket.cardId, config.trello.lists.inProgress);
      await trello.addComment(target.ticket.cardId, `🤖 Answer delivered: ${update.text}`);
    }
  }
}
