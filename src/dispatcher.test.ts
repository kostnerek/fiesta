import { describe, expect, it, vi } from 'vitest';
import { Dispatcher } from './dispatcher.js';
import type { TrelloCard } from './ticket.js';

function makeCard(overrides: Partial<TrelloCard> = {}): TrelloCard {
  return {
    id: 'card-1',
    shortLink: 'aBcD1234',
    name: 'Add HELLO file',
    desc: 'Create HELLO.md',
    labels: [{ id: 'l', name: 'demo' }],
    idList: 'list-ready',
    ...overrides,
  };
}

function build() {
  const trello = { moveCard: vi.fn(), addComment: vi.fn() };
  const herdr = {
    createWorkspace: vi.fn().mockResolvedValue({ id: 'ws-1', label: 'aBcD1234' }),
    startAgent: vi.fn().mockResolvedValue('pane-1'),
  };
  const git = {
    ensureMirror: vi.fn().mockResolvedValue('/root/repos/demo'),
    prepareWorkspace: vi.fn().mockResolvedValue('/root/work/aBcD1234'),
    writeAgentEnvFile: vi.fn().mockResolvedValue('/root/env/aBcD1234.env'),
  };
  const dispatcher = new Dispatcher({
    trello: trello as never,
    herdr: herdr as never,
    git: git as never,
    config: {
      trello: {
        lists: { backlog: 'list-backlog', inProgress: 'list-progress', blocked: 'list-blocked' },
      },
      github: { owner: 'kostnerek', token: 'gh-secret-token' },
      paths: { root: '/root', claudeCredentials: '/creds' },
    } as never,
  });
  return { dispatcher, trello, herdr, git };
}

describe('Dispatcher.claimAndStart', () => {
  it('claims the card before doing any expensive work', async () => {
    const { dispatcher, trello, git } = build();
    await dispatcher.claimAndStart(makeCard());

    expect(trello.moveCard).toHaveBeenCalledWith('card-1', 'list-progress');
    expect(trello.moveCard.mock.invocationCallOrder[0]!).toBeLessThan(
      git.ensureMirror.mock.invocationCallOrder[0]!,
    );
  });

  it('labels the herdr workspace with the card shortLink', async () => {
    const { dispatcher, herdr } = build();
    await dispatcher.claimAndStart(makeCard());
    expect(herdr.createWorkspace).toHaveBeenCalledWith('aBcD1234', '/root/work/aBcD1234');
  });

  it('gives the agent a push-capable checkout and its secrets through an env file', async () => {
    const { dispatcher, git, herdr } = build();
    await dispatcher.claimAndStart(makeCard());

    expect(git.prepareWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'kostnerek' }),
    );
    expect(git.writeAgentEnvFile).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'kostnerek', token: 'gh-secret-token' }),
    );
    const { command } = herdr.startAgent.mock.calls[0]![0] as { command: string };
    expect(command).toContain('--env-file /root/env/aBcD1234.env');
    expect(command).not.toContain('gh-secret-token');
    expect(command).not.toContain('GITHUB_TOKEN');
  });

  it('sends an unreadable card to Backlog, out of reach of the orphan rule', async () => {
    const { dispatcher, trello, git } = build();
    await dispatcher.claimAndStart(makeCard({ labels: [] }));

    expect(trello.moveCard).toHaveBeenLastCalledWith('card-1', 'list-backlog');
    expect(trello.moveCard).not.toHaveBeenCalledWith('card-1', 'list-blocked');
    expect(trello.addComment).toHaveBeenCalledWith('card-1', expect.stringMatching(/exactly one label/));
    expect(git.ensureMirror).not.toHaveBeenCalled();
  });
});
