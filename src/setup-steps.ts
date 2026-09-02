import type { ColumnName } from './config.js';
import type { TelegramClient } from './telegram.js';
import type { TrelloClient } from './trello.js';

export const COLUMN_TITLES: Record<ColumnName, string> = {
  backlog: 'Backlog',
  ready: 'Ready',
  inProgress: 'In Progress',
  blocked: 'Blocked',
  review: 'Review',
  done: 'Done',
};

export async function ensureColumns(
  trello: TrelloClient,
  boardId: string,
): Promise<Record<ColumnName, string>> {
  const existing = await trello.lists(boardId);
  const byName = new Map(existing.map((list) => [list.name.toLowerCase(), list.id]));
  const ids = {} as Record<ColumnName, string>;

  for (const [column, title] of Object.entries(COLUMN_TITLES) as [ColumnName, string][]) {
    const found = byName.get(title.toLowerCase());
    ids[column] = found ?? (await trello.createList(boardId, title)).id;
  }

  return ids;
}

export async function detectChatId(
  telegram: TelegramClient,
  sinceOffset: number,
  options: { attempts: number; delayMs: number },
): Promise<string> {
  for (let attempt = 0; attempt < options.attempts; attempt += 1) {
    const updates = await telegram.getUpdates(sinceOffset);
    const first = updates[0];
    if (first) {
      return first.chatId;
    }
    await new Promise((resolve) => setTimeout(resolve, options.delayMs));
  }
  throw new Error('Received no message from you — send any text to the bot and run setup again.');
}

export function renderEnvFile(values: Record<string, string>): string {
  return `${Object.entries(values)
    .map(([name, value]) => `${name}="${value.replace(/"/g, '\\"')}"`)
    .join('\n')}\n`;
}
