import { dirname } from 'node:path';
import type { Config } from './config.js';
import type { HerdrClient } from './herdr.js';
import { buildAgentCommand, buildPrompt } from './prompt.js';
import { readProjects, resolveProject } from './projects.js';
import type { resolveRepoSource } from './repo-source.js';
import { TicketError, toTicket, type Ticket, type TrelloCard } from './ticket.js';
import type { TrelloClient } from './trello.js';
import type {
  ensureMirror,
  prepareWorkspace,
  mirrorHasCommits,
  workspaceRoot,
  shareClaudeSession,
  writeAgentEnvFile,
} from './workspace.js';

type GitOperations = {
  ensureMirror: typeof ensureMirror;
  prepareWorkspace: typeof prepareWorkspace;
  mirrorHasCommits: typeof mirrorHasCommits;
  writeAgentEnvFile: typeof writeAgentEnvFile;
  shareClaudeSession: typeof shareClaudeSession;
  workspaceRoot: typeof workspaceRoot;
};

type ProjectOperations = {
  readProjects: typeof readProjects;
  resolveProject: typeof resolveProject;
  resolveRepoSource: typeof resolveRepoSource;
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

  async claimAndStart(
    card: TrelloCard,
    onClaimed?: (shortLink: string, title: string) => Promise<void>,
  ): Promise<void> {
    const { trello, herdr, git, projects, config } = this.deps;

    let ticket: Ticket;
    let sources;
    try {
      ticket = toTicket(card);
      const entries = projects.resolveProject(
        await projects.readProjects(config.paths.root),
        ticket.project,
      );
      sources = await Promise.all(
        entries.map((entry) => projects.resolveRepoSource(entry, config.github.owner)),
      );
    } catch (error) {
      if (!(error instanceof TicketError)) {
        throw error;
      }
      await trello.moveCard(card.id, config.trello.lists.backlog);
      await trello.addComment(card.id, `🤖 ${error.message} Fix the card and move it back to Ready.`);
      return;
    }

    await trello.moveCard(card.id, config.trello.lists.inProgress);
    await onClaimed?.(card.shortLink, card.name);

    // A repository with no commits has no base branch to branch from, and one
    // of them would otherwise fail provisioning for every ticket in the
    // project, including the ones that never touch it.
    const empty: string[] = [];
    for (const source of sources) {
      const mirrorPath = await git.ensureMirror({
        root: config.paths.root,
        source,
        token: config.github.token,
      });
      if (!(await git.mirrorHasCommits(mirrorPath))) {
        empty.push(source.dir);
        continue;
      }
      await git.prepareWorkspace({ root: config.paths.root, mirrorPath, source, ticket });
    }
    const usable = sources.filter((source) => !empty.includes(source.dir));

    const workspacePath = git.workspaceRoot(config.paths.root, ticket.shortLink);
    const session = await git.shareClaudeSession({
      home: dirname(config.paths.claudeCredentials),
    });
    const envFilePath = await git.writeAgentEnvFile({
      root: config.paths.root,
      owner: config.github.owner,
      token: config.github.token,
      sources: usable,
      prompt: buildPrompt(ticket, config.github.owner, usable, empty),
      ticket,
    });

    const workspace = await herdr.createWorkspace(ticket.shortLink, workspacePath);
    await herdr.startAgent({
      workspaceId: workspace.id,
      name: ticket.shortLink,
      command: buildAgentCommand({
        workspacePath,
        credentialsPath: session.credentialsPath,
        configPath: session.configPath,
        envFilePath,
      }),
    });

    await trello.addComment(
      card.id,
      `🤖 Started on branch \`${ticket.branch}\` in ${sources.map((source) => source.repo).join(', ')} (workspace ${workspace.id}).`,
    );
  }
}
