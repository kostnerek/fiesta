import { chmod, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { confirm, input, password, select } from '@inquirer/prompts';
import { GitHubClient } from './github.js';
import { COLUMN_TITLES, detectChatId, ensureColumns, renderEnvFile } from './setup-steps.js';
import { TelegramClient } from './telegram.js';
import {
  credentialsFile,
  defaultToolRunner,
  findMissingTools,
  hasCredentialsFile,
  REQUIRED_TOOLS,
  survivesUnraidReboot,
  unsupportedNodeVersion,
} from './tools.js';
import { TrelloClient } from './trello.js';

async function ensureTools(): Promise<void> {
  const nodeProblem = unsupportedNodeVersion(process.versions.node);
  if (nodeProblem) {
    throw new Error(nodeProblem);
  }

  for (const tool of await findMissingTools(REQUIRED_TOOLS, defaultToolRunner)) {
    if (!tool.install) {
      throw new Error(`${tool.name} is not available. ${tool.hint}`);
    }

    console.log(`\n${tool.name} is not installed.`);
    const approved = await confirm({ message: `Run "${tool.install.describe}" now?` });
    if (!approved) {
      throw new Error(`${tool.name} is not available. ${tool.hint}`);
    }

    await defaultToolRunner(tool.install.command, tool.install.args);

    if ((await findMissingTools([tool], defaultToolRunner)).length > 0) {
      throw new Error(
        `${tool.name} was installed but is not on PATH in this shell. Open a new shell and run setup again.`,
      );
    }
    console.log(`Installed ${tool.name}.`);
  }
}

async function requireSignedInClaude(directory: string): Promise<void> {
  while (!(await hasCredentialsFile(directory))) {
    console.log(`\nNo Claude credentials at ${credentialsFile(directory)}.`);
    console.log('Agents authenticate with that file, so every ticket would fail without it.');
    console.log('Run "claude" in another shell and sign in.');
    const retry = await confirm({ message: 'Signed in? Check again.' });
    if (!retry) {
      throw new Error(`Claude is not signed in: no credentials file at ${credentialsFile(directory)}.`);
    }
  }
}

async function main(): Promise<void> {
  await ensureTools();
  console.log('\n=== Trello ===');
  console.log('Open https://trello.com/power-ups/admin and copy your API key.');
  const trelloKey = await password({ message: 'Trello API key:' });
  console.log(
    `\nNow open this URL and approve access:\n` +
      `https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&key=${trelloKey}\n`,
  );
  const trelloToken = await password({ message: 'Trello token:' });

  const trello = new TrelloClient({ key: trelloKey, token: trelloToken });
  const me = await trello.me();
  console.log(`Authenticated as ${me.username}.`);

  const boards = await trello.boards();
  const boardId = await select({
    message: 'Which board should Fiesta watch?',
    choices: [
      ...boards.map((board) => ({ name: board.name, value: board.id })),
      { name: '+ create a new board', value: '__new__' },
    ],
  });
  const board =
    boardId === '__new__' ? (await trello.createBoard(await input({ message: 'New board name:' }))).id : boardId;

  const lists = await ensureColumns(trello, board);
  console.log(`Columns ready: ${Object.values(COLUMN_TITLES).join(', ')}.`);

  console.log('\n=== Telegram ===');
  const telegramToken = await password({ message: 'Telegram bot token (from @BotFather):' });
  const telegram = new TelegramClient(telegramToken);
  const bot = await telegram.getMe();
  console.log(`Bot @${bot.username} reachable.`);
  await confirm({ message: `Send any message to @${bot.username}, then confirm here.` });
  const chatId = await detectChatId(telegram, 0, { attempts: 30, delayMs: 1000 });
  console.log(`Detected chat id ${chatId}.`);

  console.log('\n=== GitHub ===');
  const githubToken = await password({ message: 'GitHub token (scope: repo):' });
  const owner = (await new GitHubClient({ token: githubToken, owner: '' }).user()).login;
  console.log(`Authenticated as ${owner}.`);

  console.log('\n=== Paths ===');
  const root = await input({
    message: 'Data root:',
    default: process.env.FIESTA_ROOT || '/mnt/user/appdata/fiesta',
  });
  const claudeCredentials = await input({
    message: 'Claude credentials directory:',
    default: process.env.CLAUDE_CREDENTIALS_PATH || join(homedir(), '.claude'),
  });
  await requireSignedInClaude(claudeCredentials);

  if (!survivesUnraidReboot(root)) {
    console.log(`\nWarning: ${root} is outside /mnt and /boot.`);
    console.log('On Unraid the OS runs from RAM, so that data would not survive a reboot.');
  }

  const envPath = join(process.cwd(), '.env');
  await writeFile(
    envPath,
    renderEnvFile({
      TRELLO_API_KEY: trelloKey,
      TRELLO_TOKEN: trelloToken,
      TRELLO_BOARD_ID: board,
      TRELLO_LIST_BACKLOG: lists.backlog,
      TRELLO_LIST_READY: lists.ready,
      TRELLO_LIST_IN_PROGRESS: lists.inProgress,
      TRELLO_LIST_BLOCKED: lists.blocked,
      TRELLO_LIST_REVIEW: lists.review,
      TRELLO_LIST_DONE: lists.done,
      TELEGRAM_BOT_TOKEN: telegramToken,
      TELEGRAM_CHAT_ID: chatId,
      GITHUB_TOKEN: githubToken,
      GITHUB_OWNER: owner,
      FIESTA_ROOT: root,
      CLAUDE_CREDENTIALS_PATH: claudeCredentials,
    }),
    { mode: 0o600 },
  );
  await chmod(envPath, 0o600);

  console.log(`\nWrote ${envPath}.`);
  console.log('Add one label per repository on the board, then start the daemon with: fiesta start');
  console.log('herdr must be running before the daemon starts, and neither survives an Unraid reboot');
  console.log('on its own — start both from a user script if you want them back after a restart.');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
