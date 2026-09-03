import type { Config } from './config.js';
import type { Dispatcher } from './dispatcher.js';
import type { ActiveTicket, Escalator } from './escalator.js';
import type { GitHubClient } from './github.js';
import type { Marker } from './markers.js';
import type { readProjects, resolveProject } from './projects.js';
import type { resolveRepoSource } from './repo-source.js';
import type { HerdrClient, HerdrWorkspace } from './herdr.js';
import { TicketError, toTicket, type Ticket, type TrelloCard } from './ticket.js';
import type { TelegramClient } from './telegram.js';
import type { TrelloClient } from './trello.js';
import {
  formatFeedback,
  highestCommentId,
  type PrComment,
  unseenComments,
} from './review-feedback.js';
import type { removeWorkspace } from './workspace.js';

const ORPHANED_COMMENT = '🤖 Agent lost (restart or crash) — returning to Ready for a fresh run.';

export const MAX_DISPATCH_FAILURES = 3;
export const MAX_TICK_FAILURES = 5;

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
  private readonly dispatchFailures = new Map<string, number>();
  private readonly lastCommentId = new Map<string, number | null>();
  private tickFailures = 0;

  constructor(
    private readonly deps: {
      trello: TrelloClient;
      herdr: HerdrClient;
      github: GitHubClient;
      projects: {
        readProjects: typeof readProjects;
        resolveProject: typeof resolveProject;
        resolveRepoSource: typeof resolveRepoSource;
      };
      dispatcher: Dispatcher;
      escalator: Escalator;
      telegram: TelegramClient;
      removeWorkspace: typeof removeWorkspace;
      config: Config;
    },
  ) {}

  async recover(): Promise<void> {
    await this.reclaimOrphans();
  }

  async runTick(): Promise<void> {
    try {
      await this.tick();
      this.tickFailures = 0;
    } catch (error) {
      this.tickFailures += 1;
      console.error(`[fiesta] tick failed (${this.tickFailures} in a row)`, error);
      if (this.tickFailures % MAX_TICK_FAILURES === 0) {
        await this.notify(
          `🤖 Fiesta has failed ${this.tickFailures} ticks in a row and is not making progress.\n\n${reason(error)}`,
        );
      }
    }
  }

  async tick(): Promise<void> {
    const { trello, herdr, escalator, config } = this.deps;

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
        await this.dispatch(next);
      }
    }
  }

  private async dispatch(card: TrelloCard): Promise<void> {
    const { dispatcher, trello, config } = this.deps;

    let failure: unknown;
    try {
      await dispatcher.claimAndStart(card);
      this.dispatchFailures.delete(card.shortLink);
      return;
    } catch (error) {
      failure = error;
    }

    const failures = (this.dispatchFailures.get(card.shortLink) ?? 0) + 1;
    this.dispatchFailures.set(card.shortLink, failures);
    console.error(
      `[fiesta] dispatch failed for card ${card.shortLink} (${failures}/${MAX_DISPATCH_FAILURES})`,
      failure,
    );
    if (failures < MAX_DISPATCH_FAILURES) {
      return;
    }

    await trello.moveCard(card.id, config.trello.lists.backlog);
    await trello.addComment(
      card.id,
      `🤖 Could not start this card ${failures} times in a row, so it is parked in Backlog. ` +
        `Last error: ${reason(failure)}. Fix the cause and move it back to Ready.`,
    );
    this.dispatchFailures.delete(card.shortLink);
    await this.notify(
      `🤖 [${card.shortLink}] ${card.name}\n\n🛑 Could not be started ${failures} times in a row; parked in Backlog.\n\n${reason(failure)}`,
    );
  }

  private async notify(text: string): Promise<void> {
    const { telegram, config } = this.deps;
    try {
      await telegram.send(config.telegram.chatId, text);
    } catch (error) {
      console.error('[fiesta] failed to send a Telegram alert', error);
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

  private async deliverReviewFeedback(
    shortLink: string,
    open: { owner: string; repo: string; number: number; url: string }[],
  ): Promise<void> {
    const { herdr, github, config } = this.deps;

    for (const pr of open) {
      const comments = await github.listPrComments(pr.owner, pr.repo, pr.number);
      const seen = this.lastCommentId.get(shortLink) ?? null;

      if (!this.lastCommentId.has(shortLink)) {
        this.lastCommentId.set(shortLink, highestCommentId(comments));
        continue;
      }

      const fresh: PrComment[] = unseenComments({
        comments,
        lastSeenId: seen,
        agentLogin: config.github.owner,
      });
      if (fresh.length === 0) {
        continue;
      }

      const workspace = await herdr.findWorkspaceByLabel(shortLink);
      if (!workspace) {
        console.error(
          `[fiesta] review feedback on ${pr.url} has nowhere to go: no live workspace for ${shortLink}`,
        );
        continue;
      }

      await herdr.sendText(await herdr.firstPaneId(workspace.id), formatFeedback({ prUrl: pr.url, comments: fresh }));
      this.lastCommentId.set(shortLink, highestCommentId(comments));
    }
  }

  private async closeMerged(): Promise<void> {
    const { trello, herdr, github, config } = this.deps;
    for (const card of await trello.cardsInList(config.trello.lists.review)) {
      try {
        const ticket = readTicket(card);
        if (!ticket) {
          continue;
        }

        const entries = this.deps.projects.resolveProject(
          await this.deps.projects.readProjects(config.paths.root),
          ticket.project,
        );
        const found = [];
        const open: { owner: string; repo: string; number: number; url: string }[] = [];
        for (const entry of entries) {
          const source = await this.deps.projects.resolveRepoSource(entry, config.github.owner);
          const pr = await github.findPrByBranch(source.owner, source.repo, ticket.branch);
          if (pr) {
            found.push(pr);
            if (!pr.merged) {
              open.push({ owner: source.owner, repo: source.repo, number: pr.number, url: pr.url });
            }
          }
        }
        if (found.length === 0 || open.length > 0) {
          await this.deliverReviewFeedback(card.shortLink, open);
          continue;
        }

        await trello.moveCard(card.id, config.trello.lists.done);
        await trello.addComment(card.id, `🤖 Merged: ${found.map((pr) => pr.url).join(', ')}`);
        const workspace = await herdr.findWorkspaceByLabel(card.shortLink);
        if (workspace) {
          await herdr.killWorkspace(workspace.id);
        }
        this.lastCommentId.delete(card.shortLink);
        await this.deps.removeWorkspace({ root: config.paths.root, shortLink: card.shortLink });
      } catch (error) {
        console.error(`[fiesta] closeMerged: failed to reconcile card ${card.shortLink}`, error);
      }
    }
  }
}
