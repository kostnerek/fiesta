import { execFile } from 'node:child_process';
import { chmod, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { confirm, input, select } from '@inquirer/prompts';
import { GitHubClient } from './github.js';
import { COLUMN_TITLES, detectChatId, ensureColumns, renderEnvFile } from './setup-steps.js';
import { TelegramClient } from './telegram.js';
import { TrelloClient } from './trello.js';

const execFileAsync = promisify(execFile);

async function requireBinaries(): Promise<void> {
  const missing: string[] = [];
  for (const binary of ['herdr', 'docker', 'git']) {
    try {
      await execFileAsync('which', [binary]);
    } catch {
      missing.push(binary);
    }
  }
  if (missing.length > 0) {
    throw new Error(`Missing required binaries: ${missing.join(', ')}`);
  }
}

async function main(): Promise<void> {
  await requireBinaries();
  console.log('\n=== Trello ===');
  console.log('Open https://trello.com/power-ups/admin and copy your API key.');
  const trelloKey = await input({ message: 'Trello API key:' });
  console.log(
    `\nNow open this URL and approve access:\n` +
      `https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&key=${trelloKey}\n`,
  );
  const trelloToken = await input({ message: 'Trello token:' });

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
  const telegramToken = await input({ message: 'Telegram bot token (from @BotFather):' });
  const telegram = new TelegramClient(telegramToken);
  const bot = await telegram.getMe();
  console.log(`Bot @${bot.username} reachable.`);
  await confirm({ message: `Send any message to @${bot.username}, then confirm here.` });
  const chatId = await detectChatId(telegram, 0, { attempts: 30, delayMs: 1000 });
  console.log(`Detected chat id ${chatId}.`);

  console.log('\n=== GitHub ===');
  const githubToken = await input({ message: 'GitHub token (scope: repo):' });
  const owner = (await new GitHubClient({ token: githubToken, owner: '' }).user()).login;
  console.log(`Authenticated as ${owner}.`);

  console.log('\n=== Paths ===');
  const root = await input({ message: 'Data root:', default: '/mnt/user/appdata/fiesta' });
  const claudeCredentials = await input({
    message: 'Claude credentials directory:',
    default: join(homedir(), '.claude'),
  });

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
  console.log('Add one label per repository on the board, then start with: pnpm start');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
