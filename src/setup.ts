import { chmod, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { confirm, input, password, select } from '@inquirer/prompts';
import { checkCredentials } from './claude-credentials.js';
import { GitHubClient } from './github.js';
import {
  askUntilValid,
  COLUMN_TITLES,
  detectChatId,
  ensureColumns,
  renderEnvFile,
} from './setup-steps.js';
import { TelegramClient } from './telegram.js';
import {
  chooseInstallDir,
  credentialsFile,
  defaultToolRunner,
  exportHint,
  findMissingTools,
  hasCredentialsFile,
  isOnPath,
  npmGlobalBinDir,
  prependToPath,
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

    const originalPath = process.env.PATH;
    const installDir = await chooseInstallDir(originalPath);
    const env = tool.install.installDirEnv
      ? { ...process.env, [tool.install.installDirEnv]: installDir }
      : undefined;

    await defaultToolRunner(tool.install.command, tool.install.args, env);

    for (const candidate of [installDir, await npmGlobalBinDir()]) {
      if (candidate) {
        prependToPath(process.env, candidate);
      }
    }

    const stillMissing = await findMissingTools([tool], defaultToolRunner);
    if (stillMissing.length > 0) {
      throw new Error(
        `${tool.name} was installed but cannot be run. Check the installer output above.`,
      );
    }

    console.log(`Installed ${tool.name}.`);
    if (!isOnPath(originalPath, installDir)) {
      console.log(`\n${installDir} is not on your PATH. Setup will carry on regardless, but the`);
      console.log('daemon needs it too, so add this to the shell that starts fiesta:');
      console.log(`  ${exportHint(installDir)}`);
      if (!survivesUnraidReboot(installDir)) {
        console.log('On Unraid this directory is lost on reboot — reinstall it from your user script.');
      }
    }
  }
}

async function requireSignedInClaude(directory: string): Promise<void> {
  for (;;) {
    const path = credentialsFile(directory);
    const state = (await hasCredentialsFile(directory))
      ? await checkCredentials(path, Date.now())
      : ({ usable: false, reason: `no credentials file at ${path}` } as const);

    if (state.usable) {
      return;
    }

    console.log(`\nClaude is not usable: ${state.reason}.`);
    console.log('Agents authenticate with that file, so every ticket would fail without it.');
    console.log('Run "claude" in another shell and sign in.');
    const retry = await confirm({ message: 'Signed in? Check again.' });
    if (!retry) {
      throw new Error(`Claude is not signed in: ${state.reason}.`);
    }
  }
}

const CREDENTIAL_ATTEMPTS = 3;
const REQUIRED_GITHUB_SCOPES = ['repo', 'read:packages'];

function reportRejected(what: string) {
  return (message: string, attemptsLeft: number): void => {
    console.log(`\n${what} was rejected: ${message}`);
    console.log(
      attemptsLeft > 0
        ? `Try again (${attemptsLeft} ${attemptsLeft === 1 ? 'attempt' : 'attempts'} left).`
        : 'No attempts left.',
    );
  };
}

async function main(): Promise<void> {
  await ensureTools();
  console.log('\n=== Trello ===');
  console.log('Fiesta reads and writes one Trello board. Open the page below, create a Power-Up');
  console.log('if you have none, and copy its API key:');
  console.log('  https://trello.com/power-ups/admin');
  const trelloCredentials = await askUntilValid({
    attempts: CREDENTIAL_ATTEMPTS,
    ask: async () => {
      const key = await password({ message: 'Trello API key:' });
      console.log(
        `\nNow open this URL and approve access:\n` +
          `https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&key=${key}\n`,
      );
      return { key, token: await password({ message: 'Trello token:' }) };
    },
    verify: async ({ key, token }) => (await new TrelloClient({ key, token }).me()).username,
    onError: reportRejected('Trello'),
  });

  const { key: trelloKey, token: trelloToken } = trelloCredentials.value;
  const trello = new TrelloClient({ key: trelloKey, token: trelloToken });
  console.log(`Authenticated as ${trelloCredentials.description}.`);

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
  console.log('Fiesta messages you through a bot you own. To create one:');
  console.log('  1. In Telegram, open a chat with @BotFather.');
  console.log('  2. Send /newbot and follow the prompts (a display name, then a username ending in "bot").');
  console.log('  3. BotFather replies with the token — copy it.');
  console.log('Already have a bot? Send /token to @BotFather to see its token again.');
  const telegramCredentials = await askUntilValid({
    attempts: CREDENTIAL_ATTEMPTS,
    ask: () => password({ message: 'Telegram bot token:' }),
    verify: async (token) => (await new TelegramClient(token).getMe()).username,
    onError: reportRejected('The Telegram bot token'),
  });

  const telegramToken = telegramCredentials.value;
  const telegram = new TelegramClient(telegramToken);
  console.log(`Bot @${telegramCredentials.description} reachable.`);
  await confirm({
    message: `Send any message to @${telegramCredentials.description}, then confirm here.`,
  });
  const chatId = await detectChatId(telegram, 0, { attempts: 30, delayMs: 1000 });
  console.log(`Detected chat id ${chatId}.`);

  console.log('\n=== GitHub ===');
  console.log('Agents push branches and open draft pull requests as you, and install private');
  console.log('packages from GitHub Packages, so the token needs "repo" and "read:packages".');
  console.log('Create one here — both scopes are preselected:');
  console.log('  https://github.com/settings/tokens/new?scopes=repo,read:packages&description=fiesta');
  const githubCredentials = await askUntilValid({
    attempts: CREDENTIAL_ATTEMPTS,
    ask: () => password({ message: 'GitHub token:' }),
    verify: async (token) => {
      const client = new GitHubClient({ token, owner: '' });
      const login = (await client.user()).login;
      const scopes = await client.tokenScopes();
      const missing = REQUIRED_GITHUB_SCOPES.filter((scope) => !scopes.includes(scope));
      if (missing.length > 0) {
        throw new Error(`the token is missing the ${missing.join(' and ')} scope`);
      }
      return login;
    },
    onError: reportRejected('The GitHub token'),
  });
  const githubToken = githubCredentials.value;
  const owner = githubCredentials.description;
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
  console.log('Next: add a project with "fiesta project", then start the daemon with "fiesta start".');
  console.log('herdr must be running before the daemon starts, and neither survives an Unraid reboot');
  console.log('on its own — start both from a user script if you want them back after a restart.');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
