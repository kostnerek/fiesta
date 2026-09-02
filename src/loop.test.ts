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

function build(overrides: { ready?: TrelloCard[]; inProgress?: TrelloCard[]; review?: TrelloCard[] } = {}) {
  const trello = {
    cardsInList: vi.fn(async (listId: string) => {
      if (listId === 'list-ready') return overrides.ready ?? [];
      if (listId === 'list-progress') return overrides.inProgress ?? [];
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
  const loop = new Loop({
    trello: trello as never,
    herdr: herdr as never,
    github: github as never,
    dispatcher: dispatcher as never,
    escalator: { inspect: vi.fn(), deliverReplies: vi.fn() } as never,
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
  return { loop, trello, herdr, dispatcher, github };
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
});
