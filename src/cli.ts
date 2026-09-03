#!/usr/bin/env node
import { join } from 'node:path';

const USAGE = `fiesta — autonomous coding agents driven by a Trello board

Usage:
  fiesta setup             Collect and verify credentials, seed the board, write .env
  fiesta start             Run the daemon
  fiesta project ...       Manage projects (a label names a project, not a repository)

Run setup once on the server, add a project, then start.`;

function loadEnvFile(): void {
  try {
    process.loadEnvFile(join(process.cwd(), '.env'));
  } catch {
    return;
  }
}

async function runProject(args: string[]): Promise<number> {
  const { loadConfig } = await import('./config.js');
  const { GitHubClient } = await import('./github.js');
  const { TrelloClient } = await import('./trello.js');
  const { runProjectCommand } = await import('./project-command.js');
  const { findGitRepos, resolveRepoSource } = await import('./repo-source.js');
  const { checkbox, confirm, input } = await import('@inquirer/prompts');
  const { homedir } = await import('node:os');
  const { join } = await import('node:path');

  const config = loadConfig(process.env);
  const github = new GitHubClient({ token: config.github.token, owner: config.github.owner });
  const trello = new TrelloClient({ key: config.trello.key, token: config.trello.token });

  let lastScanned = join(homedir(), 'repos');

  return runProjectCommand(args, {
    root: config.paths.root,
    defaultOwner: config.github.owner,
    resolveRepoSource,
    findGitRepos: (directory) => findGitRepos(directory),
    repoExists: (owner, repo) => github.repoExists(owner, repo),
    ensureLabel: async (name) => {
      const existing = await trello.labels(config.trello.boardId);
      if (existing.some((label) => label.name.toLowerCase() === name.toLowerCase())) {
        return false;
      }
      await trello.createLabel(config.trello.boardId, name);
      return true;
    },
    prompts: {
      projectName: () => input({ message: 'Project name (this becomes the board label):' }),
      scanDirectory: async () => {
        lastScanned = await input({ message: 'Scan which directory for repositories?', default: lastScanned });
        return lastScanned;
      },
      pickRepos: (found) =>
        checkbox({
          message: 'Which repositories belong to this project?',
          choices: found.map((entry) => ({ name: entry.label, value: entry.path })),
          pageSize: 20,
        }),
      scanAgain: () => confirm({ message: 'Scan another directory?', default: false }),
    },
    log: (line) => console.log(line),
  });
}

const [command, ...rest] = process.argv.slice(2);

try {
  if (command === 'setup') {
    loadEnvFile();
    await import('./setup.js');
  } else if (command === 'start') {
    loadEnvFile();
    await import('./main.js');
  } else if (command === 'project') {
    loadEnvFile();
    process.exit(await runProject(rest));
  } else {
    const askedForHelp = command === undefined || command === '--help' || command === '-h';
    console.log(askedForHelp ? USAGE : `Unknown command: ${command}\n\n${USAGE}`);
    process.exit(askedForHelp ? 0 : 1);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
