import { describe, expect, it, vi } from 'vitest';
import { Loop } from './loop.js';
import type { TrelloCard } from './ticket.js';

function makeCard(overrides: Partial<TrelloCard> = {}): TrelloCard {
  return {
    id: 'card-1',
    shortLink: 'aBcD1234',
    name: 'Add HELLO file',
    desc: '',
    labels: [{ id: 'l', name: 'demo' }],
    idList: 'list-ready',
    ...overrides,
  };
}

function build(
  overrides: {
    ready?: TrelloCard[];
    inProgress?: TrelloCard[];
    blocked?: TrelloCard[];
    review?: TrelloCard[];
  } = {},
) {
  const trello = {
    cardsInList: vi.fn(async (listId: string) => {
      if (listId === 'list-ready') return overrides.ready ?? [];
      if (listId === 'list-progress') return overrides.inProgress ?? [];
      if (listId === 'list-blocked') return overrides.blocked ?? [];
      if (listId === 'list-review') return overrides.review ?? [];
      return [];
    }),
    moveCard: vi.fn(),
    addComment: vi.fn(),
  };
  const herdr = {
    findWorkspaceByLabel: vi.fn().mockResolvedValue(null),
    firstPaneId: vi.fn().mockResolvedValue('pane-1'),
    killWorkspace: vi.fn(),
  };
  const dispatcher = { claimAndStart: vi.fn() };
  const github = { findPrByBranch: vi.fn().mockResolvedValue(null) };
  const escalator = {
    inspect: vi.fn().mockResolvedValue({ outcome: 'running', marker: null }),
    deliverReplies: vi.fn(),
  };
  const loop = new Loop({
    trello: trello as never,
    herdr: herdr as never,
    github: github as never,
    dispatcher: dispatcher as never,
    escalator: escalator as never,
    removeWorkspace: vi.fn(),
    config: {
      trello: {
        lists: {
          ready: 'list-ready',
          inProgress: 'list-progress',
          blocked: 'list-blocked',
          review: 'list-review',
          done: 'list-done',
        },
      },
      limits: { maxActive: 1 },
      paths: { root: '/root' },
    } as never,
  });
  return { loop, trello, herdr, dispatcher, github, escalator };
}

describe('Loop.recover', () => {
  it('returns an orphaned In Progress card to Ready', async () => {
    const { loop, trello } = build({ inProgress: [makeCard()] });
    await loop.recover();
    expect(trello.moveCard).toHaveBeenCalledWith('card-1', 'list-ready');
    expect(trello.addComment).toHaveBeenCalledWith('card-1', expect.stringMatching(/restart/i));
  });

  it('leaves an In Progress card whose workspace is alive', async () => {
    const { loop, trello, herdr } = build({ inProgress: [makeCard()] });
    herdr.findWorkspaceByLabel.mockResolvedValue({ id: 'ws-1', label: 'aBcD1234' });
    await loop.recover();
    expect(trello.moveCard).not.toHaveBeenCalled();
  });
});

describe('Loop.tick', () => {
  it('starts a ready card when below the active limit', async () => {
    const { loop, dispatcher } = build({ ready: [makeCard()] });
    await loop.tick();
    expect(dispatcher.claimAndStart).toHaveBeenCalledWith(expect.objectContaining({ id: 'card-1' }));
  });

  it('starts nothing when the active limit is reached by a genuinely active card', async () => {
    const { loop, dispatcher, herdr } = build({
      ready: [makeCard({ id: 'card-2' })],
      inProgress: [makeCard()],
    });
    herdr.findWorkspaceByLabel.mockResolvedValue({ id: 'ws-1', label: 'aBcD1234' });

    await loop.tick();

    expect(dispatcher.claimAndStart).not.toHaveBeenCalled();
  });

  it('reclaims an orphaned In Progress card during tick without waiting for a restart, freeing capacity', async () => {
    const { loop, trello, dispatcher } = build({
      ready: [makeCard({ id: 'card-2' })],
      inProgress: [makeCard()],
    });

    await loop.tick();

    expect(trello.moveCard).toHaveBeenCalledWith('card-1', 'list-ready');
    expect(trello.addComment).toHaveBeenCalledWith('card-1', expect.stringMatching(/restart/i));
    expect(dispatcher.claimAndStart).toHaveBeenCalledWith(expect.objectContaining({ id: 'card-2' }));
  });

  it('closes a reviewed card once its pull request is merged', async () => {
    const { loop, trello, github, herdr } = build({ review: [makeCard()] });
    github.findPrByBranch.mockResolvedValue({ number: 7, url: 'https://pr/7', merged: true });
    herdr.findWorkspaceByLabel.mockResolvedValue({ id: 'ws-1', label: 'aBcD1234' });

    await loop.tick();

    expect(trello.moveCard).toHaveBeenCalledWith('card-1', 'list-done');
    expect(herdr.killWorkspace).toHaveBeenCalledWith('ws-1');
  });

  it('reclaims a Blocked card with no live workspace, freeing capacity for a Ready card', async () => {
    const { loop, trello, dispatcher } = build({
      ready: [makeCard({ id: 'card-2' })],
      blocked: [makeCard()],
    });

    await loop.tick();

    expect(trello.moveCard).toHaveBeenCalledWith('card-1', 'list-ready');
    expect(trello.addComment).toHaveBeenCalledWith('card-1', expect.stringMatching(/restart/i));
    expect(dispatcher.claimAndStart).toHaveBeenCalledWith(expect.objectContaining({ id: 'card-2' }));
  });

  it('does not let a Blocked card with a live workspace count twice or block a Ready card wrongly', async () => {
    const { loop, trello, dispatcher, herdr } = build({
      ready: [makeCard({ id: 'card-2' })],
      blocked: [makeCard()],
    });
    herdr.findWorkspaceByLabel.mockResolvedValue({ id: 'ws-1', label: 'aBcD1234' });

    await loop.tick();

    expect(trello.moveCard).not.toHaveBeenCalledWith('card-1', 'list-ready');
    expect(dispatcher.claimAndStart).not.toHaveBeenCalled();
  });

  it('inspects a Blocked card too, so an answer typed into the pane is noticed', async () => {
    const { loop, herdr, escalator } = build({ blocked: [makeCard()] });
    herdr.findWorkspaceByLabel.mockResolvedValue({ id: 'ws-1', label: 'aBcD1234' });

    await loop.tick();

    expect(escalator.inspect).toHaveBeenCalledWith(
      expect.objectContaining({ cardId: 'card-1' }),
      'pane-1',
      expect.objectContaining({ since: null }),
    );
  });

  it('runs the silence timeout for In Progress cards only', async () => {
    const { loop, herdr, escalator } = build({ inProgress: [makeCard()] });
    herdr.findWorkspaceByLabel.mockResolvedValue({ id: 'ws-1', label: 'aBcD1234' });

    await loop.tick();

    const options = escalator.inspect.mock.calls[0]![2] as { since: number | null };
    expect(typeof options.since).toBe('number');
  });

  it('remembers the marker it handled and passes it back on the next tick', async () => {
    const { loop, herdr, escalator } = build({ blocked: [makeCard()] });
    herdr.findWorkspaceByLabel.mockResolvedValue({ id: 'ws-1', label: 'aBcD1234' });
    const marker = { kind: 'ASK', text: 'Which provider?' };
    escalator.inspect.mockResolvedValue({ outcome: 'blocked', marker });

    await loop.tick();
    await loop.tick();

    expect(escalator.inspect).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      'pane-1',
      expect.objectContaining({ lastMarker: null }),
    );
    expect(escalator.inspect).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      'pane-1',
      expect.objectContaining({ lastMarker: marker }),
    );
  });

  it('forgets a card once it leaves the active columns', async () => {
    const cards = { inProgress: [makeCard()] as TrelloCard[] };
    const { loop, herdr, escalator } = build(cards);
    herdr.findWorkspaceByLabel.mockResolvedValue({ id: 'ws-1', label: 'aBcD1234' });
    escalator.inspect.mockResolvedValue({
      outcome: 'blocked',
      marker: { kind: 'ASK', text: 'Which provider?' },
    });

    await loop.tick();
    cards.inProgress = [];
    await loop.tick();
    cards.inProgress = [makeCard()];
    await loop.tick();

    expect(escalator.inspect).toHaveBeenLastCalledWith(
      expect.anything(),
      'pane-1',
      expect.objectContaining({ lastMarker: null }),
    );
  });

  it('isolates a card whose herdr lookup rejects so the rest of the board still gets processed', async () => {
    const orphan = makeCard({ id: 'card-1', shortLink: 'aBcD1234' });
    const healthy = makeCard({ id: 'card-2', shortLink: 'zZzZ9999' });
    const { loop, trello, dispatcher, herdr } = build({
      ready: [makeCard({ id: 'card-3' })],
      inProgress: [orphan, healthy],
    });
    herdr.findWorkspaceByLabel.mockImplementation(async (shortLink: string) => {
      if (shortLink === 'aBcD1234') {
        throw new Error('herdr unreachable for this card');
      }
      return null;
    });

    await loop.tick();

    expect(trello.moveCard).toHaveBeenCalledWith('card-2', 'list-ready');
    expect(trello.addComment).toHaveBeenCalledWith('card-2', expect.stringMatching(/restart/i));
    expect(trello.moveCard).not.toHaveBeenCalledWith('card-1', expect.anything());
    expect(dispatcher.claimAndStart).toHaveBeenCalledWith(expect.objectContaining({ id: 'card-3' }));
  });
});
