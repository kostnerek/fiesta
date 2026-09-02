import { describe, expect, it } from 'vitest';
import { TicketError, toTicket, type TrelloCard } from './ticket.js';

function makeCard(overrides: Partial<TrelloCard> = {}): TrelloCard {
  return {
    id: 'card-1',
    shortLink: 'aBcD1234',
    name: 'Add HELLO file',
    desc: 'Create HELLO.md at the repo root.',
    labels: [{ id: 'lab-1', name: 'fiesta' }],
    idList: 'list-ready',
    ...overrides,
  };
}

describe('toTicket', () => {
  it('takes the repo from the single label', () => {
    expect(toTicket(makeCard()).repo).toBe('fiesta');
  });

  it('defaults the base branch to main', () => {
    expect(toTicket(makeCard()).baseBranch).toBe('main');
  });

  it('reads an explicit base branch from the description', () => {
    const card = makeCard({ desc: 'base: develop\n\nDo the thing.' });
    expect(toTicket(card).baseBranch).toBe('develop');
  });

  it('builds a deterministic branch name from shortLink and title', () => {
    const card = makeCard({ name: 'Add HELLO file, please!' });
    expect(toTicket(card).branch).toBe('fiesta/aBcD1234-add-hello-file-please');
  });

  it('rejects a card with no label', () => {
    expect(() => toTicket(makeCard({ labels: [] }))).toThrow(TicketError);
  });

  it('rejects a card with more than one label', () => {
    const card = makeCard({
      labels: [
        { id: 'a', name: 'fiesta' },
        { id: 'b', name: 'trader' },
      ],
    });
    expect(() => toTicket(card)).toThrow(TicketError);
  });
});
