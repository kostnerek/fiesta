import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { banner, startupLines } from './banner.js';
import { checkCredentials } from './claude-credentials.js';
import { Dispatcher } from './dispatcher.js';
import { loadConfig } from './config.js';
import { Escalator } from './escalator.js';
import { GitHubClient } from './github.js';
import { HerdrClient } from './herdr.js';
import { Loop } from './loop.js';
import { readProjects, resolveProject } from './projects.js';
import { resolveRepoSource } from './repo-source.js';
import { TelegramClient } from './telegram.js';
import { TrelloClient } from './trello.js';
import {
  ensureMirror,
  prepareWorkspace,
  removeWorkspace,
  workspaceRoot,
  writeAgentCredentials,
  writeAgentEnvFile,
} from './workspace.js';

async function readVersion(): Promise<string> {
  try {
    const path = fileURLToPath(new URL('../package.json', import.meta.url));
    return (JSON.parse(await readFile(path, 'utf8')) as { version?: string }).version ?? '';
  } catch {
    return '';
  }
}

const config = loadConfig(process.env);

for (const line of banner()) {
  console.log(line);
}
console.log('');
for (const line of startupLines({
  config,
  projects: Object.keys(await readProjects(config.paths.root)).sort(),
  version: await readVersion(),
})) {
  console.log(line);
}
console.log('');

const trello = new TrelloClient({ key: config.trello.key, token: config.trello.token });
const herdr = new HerdrClient();
const telegram = new TelegramClient(config.telegram.botToken);
const github = new GitHubClient({ token: config.github.token, owner: config.github.owner });

const loop = new Loop({
  trello,
  herdr,
  github,
  projects: { readProjects, resolveProject, resolveRepoSource },
  dispatcher: new Dispatcher({
    trello,
    herdr,
    git: {
      ensureMirror,
      prepareWorkspace,
      writeAgentEnvFile,
      writeAgentCredentials,
      workspaceRoot,
    },
    projects: { readProjects, resolveProject, resolveRepoSource },
    config,
  }),
  escalator: new Escalator({ herdr, telegram, trello, config }),
  telegram,
  removeWorkspace,
  checkCredentials,
  config,
});

try {
  await loop.recover();
} catch (error) {
  console.error('[fiesta] recover failed', error);
}

for (;;) {
  await loop.runTick();
  await new Promise((resolve) => setTimeout(resolve, config.limits.pollIntervalMs));
}
