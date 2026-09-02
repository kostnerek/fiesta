export type TrelloLabel = { id: string; name: string };

export type TrelloCard = {
  id: string;
  shortLink: string;
  name: string;
  desc: string;
  labels: TrelloLabel[];
  idList: string;
};

export type Ticket = {
  cardId: string;
  shortLink: string;
  title: string;
  description: string;
  repo: string;
  baseBranch: string;
  branch: string;
};

export class TicketError extends Error {}

const BASE_BRANCH_LINE = /^base:[ \t]*(\S+)[ \t]*$/m;
const MAX_SLUG_LENGTH = 40;

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, '');
}

export function toTicket(card: TrelloCard): Ticket {
  if (card.labels.length !== 1) {
    throw new TicketError(
      `Card "${card.name}" needs exactly one label naming the repository, found ${card.labels.length}.`,
    );
  }

  const repo = card.labels[0]!.name;
  const baseBranch = BASE_BRANCH_LINE.exec(card.desc)?.[1] ?? 'main';

  return {
    cardId: card.id,
    shortLink: card.shortLink,
    title: card.name,
    description: card.desc,
    repo,
    baseBranch,
    branch: `fiesta/${card.shortLink}-${slugify(card.name)}`,
  };
}
