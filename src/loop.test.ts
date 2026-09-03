import { describe, expect, it, vi } from 'vitest';
import { Loop, MAX_DISPATCH_FAILURES, MAX_TICK_FAILURES } from './loop.js';
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
    sendText: vi.fn(),
  };
  const dispatcher = { claimAndStart: vi.fn() };
  const github = {
    findPrByBranch: vi.fn().mockResolvedValue(null),
    listPrComments: vi.fn().mockResolvedValue([]),
  };
  const escalator = {
    inspect: vi.fn().mockResolvedValue({ outcome: 'running', marker: null }),
    deliverReplies: vi.fn(),
  };
  const telegram = { send: vi.fn() };
  const projects = {
    readProjects: vi.fn().mockResolvedValue({ demo: ['demo'] }),
    resolveProject: vi.fn().mockReturnValue(['demo']),
    resolveRepoSource: vi.fn(async (entry: string, owner: string) => ({
      dir: entry,
      owner,
      repo: entry,
      localPath: null,
    })),
  };
  const loop = new Loop({
    trello: trello as never,
    herdr: herdr as never,
    github: github as never,
    projects: projects as never,
    dispatcher: dispatcher as never,
    escalator: escalator as never,
    telegram: telegram as never,
    removeWorkspace: vi.fn(),
    config: {
      telegram: { chatId: '42' },
      trello: {
        lists: {
          backlog: 'list-backlog',
          ready: 'list-ready',
          inProgress: 'list-progress',
          blocked: 'list-blocked',
          review: 'list-review',
          done: 'list-done',
        },
      },
      github: { owner: 'kostnerek', token: 'gh' },
      limits: { maxActive: 1 },
      paths: { root: '/root' },
    } as never,
  });
  return { loop, trello, herdr, dispatcher, github, escalator, telegram, projects };
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

describe('Loop retry bounds', () => {
  it('parks a card in Backlog and pings Telegram after N consecutive dispatch failures', async () => {
    const { loop, trello, dispatcher, telegram } = build({ ready: [makeCard()] });
    dispatcher.claimAndStart.mockRejectedValue(new Error('clone exploded'));

    for (let attempt = 0; attempt < MAX_DISPATCH_FAILURES; attempt += 1) {
      await loop.tick();
    }

    expect(dispatcher.claimAndStart).toHaveBeenCalledTimes(MAX_DISPATCH_FAILURES);
    expect(trello.moveCard).toHaveBeenCalledWith('card-1', 'list-backlog');
    expect(trello.addComment).toHaveBeenCalledWith('card-1', expect.stringMatching(/clone exploded/));
    expect(telegram.send).toHaveBeenCalledWith('42', expect.stringContaining('aBcD1234'));
  });

  it('keeps retrying until the bound is reached, not before', async () => {
    const { loop, trello, telegram, dispatcher } = build({ ready: [makeCard()] });
    dispatcher.claimAndStart.mockRejectedValue(new Error('clone exploded'));

    for (let attempt = 0; attempt < MAX_DISPATCH_FAILURES - 1; attempt += 1) {
      await loop.tick();
    }

    expect(trello.moveCard).not.toHaveBeenCalledWith('card-1', 'list-backlog');
    expect(telegram.send).not.toHaveBeenCalled();
  });

  it('forgets earlier failures once a card starts', async () => {
    const { loop, trello, dispatcher } = build({ ready: [makeCard()] });
    dispatcher.claimAndStart
      .mockRejectedValueOnce(new Error('flaky'))
      .mockRejectedValueOnce(new Error('flaky'))
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new Error('flaky'));

    for (let attempt = 0; attempt < MAX_DISPATCH_FAILURES + 1; attempt += 1) {
      await loop.tick();
    }

    expect(trello.moveCard).not.toHaveBeenCalledWith('card-1', 'list-backlog');
  });

  it('pings Telegram after N consecutive whole-tick failures', async () => {
    const { loop, trello, telegram } = build();
    trello.cardsInList.mockRejectedValue(new Error('Trello 500'));

    for (let attempt = 0; attempt < MAX_TICK_FAILURES - 1; attempt += 1) {
      await loop.runTick();
    }
    expect(telegram.send).not.toHaveBeenCalled();

    await loop.runTick();

    expect(telegram.send).toHaveBeenCalledWith('42', expect.stringMatching(/Trello 500/));
  });

  it('resets the tick failure count after a tick that works', async () => {
    const { loop, trello, telegram } = build();
    trello.cardsInList.mockRejectedValue(new Error('Trello 500'));

    for (let attempt = 0; attempt < MAX_TICK_FAILURES - 1; attempt += 1) {
      await loop.runTick();
    }
    trello.cardsInList.mockResolvedValue([]);
    await loop.runTick();
    trello.cardsInList.mockRejectedValue(new Error('Trello 500'));
    await loop.runTick();

    expect(telegram.send).not.toHaveBeenCalled();
  });

  it('keeps ticking when the Telegram alert itself fails', async () => {
    const { loop, trello, telegram } = build();
    trello.cardsInList.mockRejectedValue(new Error('Trello 500'));
    telegram.send.mockRejectedValue(new Error('telegram down'));

    for (let attempt = 0; attempt < MAX_TICK_FAILURES; attempt += 1) {
      await expect(loop.runTick()).resolves.toBeUndefined();
    }

    expect(telegram.send).toHaveBeenCalled();
  });
});

describe('Loop.closeMerged across several repositories', () => {
  it('waits until every pull request the agent opened is merged', async () => {
    const { loop, trello, github, projects } = build({ review: [makeCard()] });
    projects.resolveProject.mockReturnValue(['platform', 'backoffice']);
    github.findPrByBranch.mockImplementation(async (_owner: string, repo: string) =>
      repo === 'platform'
        ? { number: 7, url: 'https://pr/7', merged: true }
        : { number: 8, url: 'https://pr/8', merged: false },
    );

    await loop.tick();

    expect(trello.moveCard).not.toHaveBeenCalledWith('card-1', 'list-done');
  });

  it('closes the card once all of them are merged, naming each', async () => {
    const { loop, trello, github, projects, herdr } = build({ review: [makeCard()] });
    projects.resolveProject.mockReturnValue(['platform', 'backoffice']);
    herdr.findWorkspaceByLabel.mockResolvedValue({ id: 'ws-1', label: 'aBcD1234' });
    github.findPrByBranch.mockImplementation(async (_owner: string, repo: string) => ({
      number: repo === 'platform' ? 7 : 8,
      url: `https://pr/${repo}`,
      merged: true,
    }));

    await loop.tick();

    expect(trello.moveCard).toHaveBeenCalledWith('card-1', 'list-done');
    expect(trello.addComment).toHaveBeenCalledWith(
      'card-1',
      expect.stringContaining('https://pr/platform, https://pr/backoffice'),
    );
  });

  it('ignores repositories the agent never opened a pull request in', async () => {
    const { loop, trello, github, projects, herdr } = build({ review: [makeCard()] });
    projects.resolveProject.mockReturnValue(['platform', 'backoffice']);
    herdr.findWorkspaceByLabel.mockResolvedValue({ id: 'ws-1', label: 'aBcD1234' });
    github.findPrByBranch.mockImplementation(async (_owner: string, repo: string) =>
      repo === 'platform' ? { number: 7, url: 'https://pr/7', merged: true } : null,
    );

    await loop.tick();

    expect(trello.moveCard).toHaveBeenCalledWith('card-1', 'list-done');
  });

  it('leaves a card alone when the agent opened no pull request at all', async () => {
    const { loop, trello, projects } = build({ review: [makeCard()] });
    projects.resolveProject.mockReturnValue(['platform', 'backoffice']);

    await loop.tick();

    expect(trello.moveCard).not.toHaveBeenCalledWith('card-1', 'list-done');
  });
});

describe('Loop review feedback', () => {
  function reviewing(overrides: { comments?: unknown[] } = {}) {
    const built = build({ review: [makeCard()] });
    built.projects.resolveProject.mockReturnValue(['platform']);
    built.github.findPrByBranch.mockResolvedValue({ number: 7, url: 'https://pr/7', merged: false });
    built.herdr.findWorkspaceByLabel.mockResolvedValue({ id: 'ws-1', label: 'aBcD1234' });
    built.github.listPrComments.mockResolvedValue(overrides.comments ?? []);
    return built;
  }

  it('does not replay comments that were already there when it first looked', async () => {
    const { loop, herdr } = reviewing({
      comments: [{ id: 5, author: 'ola', body: 'old note', path: null, line: null }],
    });

    await loop.tick();

    expect(herdr.sendText).not.toHaveBeenCalled();
  });

  it('delivers a comment left after it started watching', async () => {
    const { loop, herdr, github } = reviewing({ comments: [] });
    await loop.tick();

    github.listPrComments.mockResolvedValue([
      { id: 9, author: 'ola', body: 'rename this', path: 'src/a.ts', line: 3 },
    ]);
    await loop.tick();

    expect(herdr.sendText).toHaveBeenCalledTimes(1);
    expect(herdr.sendText.mock.calls[0]![1]).toContain('- ola on src/a.ts:3: rename this');
  });

  it('delivers each comment once, not on every tick', async () => {
    const { loop, herdr, github } = reviewing({ comments: [] });
    await loop.tick();
    github.listPrComments.mockResolvedValue([
      { id: 9, author: 'ola', body: 'rename this', path: null, line: null },
    ]);
    await loop.tick();
    await loop.tick();

    expect(herdr.sendText).toHaveBeenCalledTimes(1);
  });

  it('ignores the agent answering itself on the pull request', async () => {
    const { loop, herdr, github } = reviewing({ comments: [] });
    await loop.tick();
    github.listPrComments.mockResolvedValue([
      { id: 9, author: 'kostnerek', body: 'pushed a fix', path: null, line: null },
    ]);
    await loop.tick();

    expect(herdr.sendText).not.toHaveBeenCalled();
  });

  it('says so rather than losing feedback when the session is gone', async () => {
    const { loop, herdr, github } = reviewing({ comments: [] });
    await loop.tick();
    github.listPrComments.mockResolvedValue([
      { id: 9, author: 'ola', body: 'rename this', path: null, line: null },
    ]);
    herdr.findWorkspaceByLabel.mockResolvedValue(null);
    await loop.tick();

    expect(herdr.sendText).not.toHaveBeenCalled();
  });

  it('stops polling once every pull request is merged', async () => {
    const { loop, trello, github, herdr } = reviewing({ comments: [] });
    await loop.tick();
    github.findPrByBranch.mockResolvedValue({ number: 7, url: 'https://pr/7', merged: true });
    github.listPrComments.mockClear();

    await loop.tick();

    expect(trello.moveCard).toHaveBeenCalledWith('card-1', 'list-done');
    expect(github.listPrComments).not.toHaveBeenCalled();
    expect(herdr.killWorkspace).toHaveBeenCalled();
  });
});
