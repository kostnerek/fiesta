import { Dispatcher } from './dispatcher.js';
import { loadConfig } from './config.js';
import { Escalator } from './escalator.js';
import { GitHubClient } from './github.js';
import { HerdrClient } from './herdr.js';
import { Loop } from './loop.js';
import { TelegramClient } from './telegram.js';
import { TrelloClient } from './trello.js';
import { ensureMirror, prepareWorkspace, removeWorkspace } from './workspace.js';

const config = loadConfig(process.env);

const trello = new TrelloClient({ key: config.trello.key, token: config.trello.token });
const herdr = new HerdrClient();
const telegram = new TelegramClient(config.telegram.botToken);
const github = new GitHubClient({ token: config.github.token, owner: config.github.owner });

const loop = new Loop({
  trello,
  herdr,
  github,
  dispatcher: new Dispatcher({ trello, herdr, git: { ensureMirror, prepareWorkspace }, config }),
  escalator: new Escalator({ herdr, telegram, trello, config }),
  removeWorkspace,
  config,
});

await loop.recover();

for (;;) {
  try {
    await loop.tick();
  } catch (error) {
    console.error('[fiesta] tick failed', error);
  }
  await new Promise((resolve) => setTimeout(resolve, config.limits.pollIntervalMs));
}
