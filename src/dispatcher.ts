import type { Config } from './config.js';
import type { HerdrClient } from './herdr.js';
import { buildAgentCommand, buildPrompt } from './prompt.js';
import { readProjects, resolveProject } from './projects.js';
import { TicketError, toTicket, type Ticket, type TrelloCard } from './ticket.js';
import type { TrelloClient } from './trello.js';
import type {
  ensureMirror,
  prepareWorkspace,
  workspaceRoot,
  writeAgentEnvFile,
} from './workspace.js';

type GitOperations = {
  ensureMirror: typeof ensureMirror;
  prepareWorkspace: typeof prepareWorkspace;
  writeAgentEnvFile: typeof writeAgentEnvFile;
  workspaceRoot: typeof workspaceRoot;
};

type ProjectOperations = {
  readProjects: typeof readProjects;
  resolveProject: typeof resolveProject;
};

export class Dispatcher {
  constructor(
    private readonly deps: {
      trello: TrelloClient;
      herdr: HerdrClient;
      git: GitOperations;
      projects: ProjectOperations;
      config: Config;
    },
  ) {}

  async claimAndStart(card: TrelloCard): Promise<void> {
    const { trello, herdr, git, projects, config } = this.deps;

    let ticket: Ticket;
    let repos: string[];
    try {
      ticket = toTicket(card);
      repos = projects.resolveProject(await projects.readProjects(config.paths.root), ticket.project);
    } catch (error) {
      if (!(error instanceof TicketError)) {
        throw error;
      }
      await trello.moveCard(card.id, config.trello.lists.backlog);
      await trello.addComment(card.id, `🤖 ${error.message} Fix the card and move it back to Ready.`);
      return;
    }

    await trello.moveCard(card.id, config.trello.lists.inProgress);

    for (const repo of repos) {
      const mirrorPath = await git.ensureMirror({
        root: config.paths.root,
        owner: config.github.owner,
        repo,
        token: config.github.token,
      });
      await git.prepareWorkspace({
        root: config.paths.root,
        mirrorPath,
        owner: config.github.owner,
        repo,
        ticket,
      });
    }

    const workspacePath = git.workspaceRoot(config.paths.root, ticket.shortLink);
    const envFilePath = await git.writeAgentEnvFile({
      root: config.paths.root,
      owner: config.github.owner,
      token: config.github.token,
      repos,
      ticket,
    });

    const workspace = await herdr.createWorkspace(ticket.shortLink, workspacePath);
    await herdr.startAgent({
      workspaceId: workspace.id,
      name: ticket.shortLink,
      command: buildAgentCommand({
        workspacePath,
        claudeCredentials: config.paths.claudeCredentials,
        envFilePath,
        prompt: buildPrompt(ticket, config.github.owner, repos),
      }),
    });

    await trello.addComment(
      card.id,
      `🤖 Started on branch \`${ticket.branch}\` in ${repos.join(', ')} (workspace ${workspace.id}).`,
    );
  }
}
