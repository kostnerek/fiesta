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
  project: string;
  baseBranch: string;
  branch: string;
};

export class TicketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TicketError';
  }
}

const BASE_BRANCH_LINE = /^base:[ \t]*(\S+)[ \t]*$/m;
const SHORT_LINK = /^[A-Za-z0-9]+$/;
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
      `Card "${card.name}" needs exactly one label naming the project, found ${card.labels.length}.`,
    );
  }

  if (!SHORT_LINK.test(card.shortLink)) {
    throw new TicketError(`Card "${card.name}" has an unusable shortLink "${card.shortLink}".`);
  }

  const project = card.labels[0]!.name;
  const baseBranch = BASE_BRANCH_LINE.exec(card.desc)?.[1] ?? 'main';

  return {
    cardId: card.id,
    shortLink: card.shortLink,
    title: card.name,
    description: card.desc,
    project,
    baseBranch,
    branch: `fiesta/${card.shortLink}-${slugify(card.name)}`,
  };
}
