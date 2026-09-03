export type ColumnName = 'backlog' | 'ready' | 'inProgress' | 'blocked' | 'review' | 'done';

export type Config = {
  trello: { key: string; token: string; boardId: string; lists: Record<ColumnName, string> };
  telegram: { botToken: string; chatId: string };
  github: { token: string; owner: string };
  paths: { root: string; claudeCredentials: string };
  limits: { maxActive: number; ticketTimeoutMs: number; pollIntervalMs: number };
};

const LIST_VARS: Record<ColumnName, string> = {
  backlog: 'TRELLO_LIST_BACKLOG',
  ready: 'TRELLO_LIST_READY',
  inProgress: 'TRELLO_LIST_IN_PROGRESS',
  blocked: 'TRELLO_LIST_BLOCKED',
  review: 'TRELLO_LIST_REVIEW',
  done: 'TRELLO_LIST_DONE',
};

const REQUIRED = [
  'TRELLO_API_KEY',
  'TRELLO_TOKEN',
  'TRELLO_BOARD_ID',
  ...Object.values(LIST_VARS),
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'GITHUB_TOKEN',
  'GITHUB_OWNER',
  'FIESTA_ROOT',
  'CLAUDE_CREDENTIALS_PATH',
];

function positiveNumber(name: string, raw: string | undefined, fallback: number): number {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return fallback;
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid configuration: ${name} must be a positive number, got "${raw}".`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const missing = REQUIRED.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing configuration: ${missing.join(', ')}. Run "pnpm setup".`);
  }

  const lists = Object.fromEntries(
    Object.entries(LIST_VARS).map(([column, variable]) => [column, env[variable] as string]),
  ) as Record<ColumnName, string>;

  return {
    trello: {
      key: env.TRELLO_API_KEY as string,
      token: env.TRELLO_TOKEN as string,
      boardId: env.TRELLO_BOARD_ID as string,
      lists,
    },
    telegram: {
      botToken: env.TELEGRAM_BOT_TOKEN as string,
      chatId: env.TELEGRAM_CHAT_ID as string,
    },
    github: { token: env.GITHUB_TOKEN as string, owner: env.GITHUB_OWNER as string },
    paths: {
      root: env.FIESTA_ROOT as string,
      claudeCredentials: env.CLAUDE_CREDENTIALS_PATH as string,
    },
    limits: {
      maxActive: positiveNumber('MAX_ACTIVE', env.MAX_ACTIVE, 1),
      ticketTimeoutMs: positiveNumber('TICKET_TIMEOUT_MIN', env.TICKET_TIMEOUT_MIN, 60) * 60 * 1000,
      pollIntervalMs: positiveNumber('POLL_INTERVAL_SEC', env.POLL_INTERVAL_SEC, 30) * 1000,
    },
  };
}
