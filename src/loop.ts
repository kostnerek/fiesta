import type { Config } from './config.js';
import type { Dispatcher } from './dispatcher.js';
import type { ActiveTicket, Escalator } from './escalator.js';
import type { GitHubClient } from './github.js';
import type { Marker } from './markers.js';
import type { HerdrClient, HerdrWorkspace } from './herdr.js';
import { TicketError, toTicket, type Ticket, type TrelloCard } from './ticket.js';
import type { TrelloClient } from './trello.js';
import type { removeWorkspace } from './workspace.js';

const ORPHANED_COMMENT = '🤖 Agent lost (restart or crash) — returning to Ready for a fresh run.';

function readTicket(card: TrelloCard): Ticket | null {
  try {
    return toTicket(card);
  } catch (error) {
    if (error instanceof TicketError) {
      return null;
    }
    throw error;
  }
}

type ActiveWorkspaceCard = { card: TrelloCard; workspace: HerdrWorkspace };
type ReclaimResult = { inProgress: ActiveWorkspaceCard[]; blocked: ActiveWorkspaceCard[] };

export class Loop {
  private readonly lastActivityAt = new Map<string, number>();
  private readonly lastMarker = new Map<string, Marker>();

  constructor(
    private readonly deps: {
      trello: TrelloClient;
      herdr: HerdrClient;
      github: GitHubClient;
      dispatcher: Dispatcher;
      escalator: Escalator;
      removeWorkspace: typeof removeWorkspace;
      config: Config;
    },
  ) {}

  async recover(): Promise<void> {
    await this.reclaimOrphans();
  }

  async tick(): Promise<void> {
    const { trello, herdr, dispatcher, escalator, config } = this.deps;

    const { inProgress, blocked } = await this.reclaimOrphans();

    const active = new Map<string, ActiveTicket>();

    for (const { card, workspace } of [...inProgress, ...blocked]) {
      const ticket = readTicket(card);
      if (!ticket) {
        continue;
      }
      try {
        active.set(card.shortLink, { ticket, paneId: await herdr.firstPaneId(workspace.id) });
      } catch (error) {
        console.error(`[fiesta] tick: failed to resolve pane for card ${card.shortLink}`, error);
      }
    }

    await escalator.deliverReplies(active);

    const inspectable = [
      ...inProgress.map(({ card }) => ({ card, waitingForHuman: false })),
      ...blocked.map(({ card }) => ({ card, waitingForHuman: true })),
    ];

    for (const { card, waitingForHuman } of inspectable) {
      const entry = active.get(card.shortLink);
      if (!entry) {
        continue;
      }
      let since: number | null = null;
      if (!waitingForHuman) {
        since = this.lastActivityAt.get(card.shortLink) ?? Date.now();
        this.lastActivityAt.set(card.shortLink, since);
      }
      try {
        const { outcome, marker } = await escalator.inspect(entry.ticket, entry.paneId, {
          since,
          lastMarker: this.lastMarker.get(card.shortLink) ?? null,
        });
        if (marker) {
          this.lastMarker.set(card.shortLink, marker);
        }
        if (outcome !== 'running') {
          this.lastActivityAt.delete(card.shortLink);
        }
      } catch (error) {
        console.error(`[fiesta] tick: inspect failed for card ${card.shortLink}`, error);
      }
    }

    this.forget(inspectable.map(({ card }) => card.shortLink));

    await this.closeMerged();

    if (inProgress.length + blocked.length < config.limits.maxActive) {
      const ready = await trello.cardsInList(config.trello.lists.ready);
      const next = ready[0];
      if (next) {
        await dispatcher.claimAndStart(next);
      }
    }
  }

  private forget(stillActive: string[]): void {
    const keep = new Set(stillActive);
    for (const map of [this.lastActivityAt, this.lastMarker]) {
      for (const shortLink of [...map.keys()]) {
        if (!keep.has(shortLink)) {
          map.delete(shortLink);
        }
      }
    }
  }

  private async reclaimOrphans(): Promise<ReclaimResult> {
    const { trello, herdr, config } = this.deps;
    const targets = [
      { origin: 'inProgress' as const, listId: config.trello.lists.inProgress },
      { origin: 'blocked' as const, listId: config.trello.lists.blocked },
    ];
    const result: ReclaimResult = { inProgress: [], blocked: [] };

    for (const { origin, listId } of targets) {
      for (const card of await trello.cardsInList(listId)) {
        try {
          const workspace = await herdr.findWorkspaceByLabel(card.shortLink);
          if (workspace) {
            result[origin].push({ card, workspace });
            continue;
          }
          await trello.moveCard(card.id, config.trello.lists.ready);
          await trello.addComment(card.id, ORPHANED_COMMENT);
        } catch (error) {
          console.error(`[fiesta] reclaimOrphans: failed to reconcile card ${card.shortLink}`, error);
        }
      }
    }

    return result;
  }

  private async closeMerged(): Promise<void> {
    const { trello, herdr, github, config } = this.deps;
    for (const card of await trello.cardsInList(config.trello.lists.review)) {
      try {
        const ticket = readTicket(card);
        if (!ticket) {
          continue;
        }
        const pr = await github.findPrByBranch(ticket.repo, ticket.branch);
        if (!pr?.merged) {
          continue;
        }
        await trello.moveCard(card.id, config.trello.lists.done);
        await trello.addComment(card.id, `🤖 Merged: ${pr.url}`);
        const workspace = await herdr.findWorkspaceByLabel(card.shortLink);
        if (workspace) {
          await herdr.killWorkspace(workspace.id);
        }
        await this.deps.removeWorkspace({ root: config.paths.root, shortLink: card.shortLink });
      } catch (error) {
        console.error(`[fiesta] closeMerged: failed to reconcile card ${card.shortLink}`, error);
      }
    }
  }
}
