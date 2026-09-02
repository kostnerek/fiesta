import type { Config } from './config.js';
import type { HerdrClient } from './herdr.js';
import { buildAgentCommand, buildPrompt } from './prompt.js';
import { TicketError, toTicket, type TrelloCard } from './ticket.js';
import type { TrelloClient } from './trello.js';
import type { ensureMirror, prepareWorkspace } from './workspace.js';

type GitOperations = {
  ensureMirror: typeof ensureMirror;
  prepareWorkspace: typeof prepareWorkspace;
};

export class Dispatcher {
  constructor(
    private readonly deps: {
      trello: TrelloClient;
      herdr: HerdrClient;
      git: GitOperations;
      config: Config;
    },
  ) {}

  async claimAndStart(card: TrelloCard): Promise<void> {
    const { trello, herdr, git, config } = this.deps;

    let ticket;
    try {
      ticket = toTicket(card);
    } catch (error) {
      if (!(error instanceof TicketError)) {
        throw error;
      }
      await trello.moveCard(card.id, config.trello.lists.blocked);
      await trello.addComment(card.id, `🤖 ${error.message}`);
      return;
    }

    await trello.moveCard(card.id, config.trello.lists.inProgress);

    const mirrorPath = await git.ensureMirror({
      root: config.paths.root,
      owner: config.github.owner,
      repo: ticket.repo,
      token: config.github.token,
    });
    const workspacePath = await git.prepareWorkspace({ root: config.paths.root, mirrorPath, ticket });

    const workspace = await herdr.createWorkspace(ticket.shortLink, workspacePath);
    await herdr.startAgent({
      workspaceId: workspace.id,
      name: ticket.shortLink,
      command: buildAgentCommand({
        workspacePath,
        claudeCredentials: config.paths.claudeCredentials,
        githubToken: config.github.token,
        prompt: buildPrompt(ticket),
      }),
    });

    await trello.addComment(card.id, `🤖 Started on branch \`${ticket.branch}\` (workspace ${workspace.id}).`);
  }
}
