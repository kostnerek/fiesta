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
    expect(toTicket(makeCard()).project).toBe('fiesta');
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

  it('names itself in log output instead of a bare "Error:"', () => {
    let caught: unknown;
    try {
      toTicket(makeCard({ labels: [] }));
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).name).toBe('TicketError');
    expect(String(caught)).toMatch(/^TicketError: /);
  });

  it('rejects a card whose shortLink contains shell metacharacters', () => {
    const card = makeCard({ shortLink: 'aB;rm -rf /' });
    expect(() => toTicket(card)).toThrow(TicketError);
  });
});

describe('toTicket when Trello omits labels', () => {
  it('reports a readable error instead of crashing on undefined', () => {
    const card = { ...makeCard(), labels: undefined } as unknown as TrelloCard;
    expect(() => toTicket(card)).toThrow(TicketError);
    expect(() => toTicket(card)).toThrow(/without its labels/);
  });
});
