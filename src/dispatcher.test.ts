import { describe, expect, it, vi } from 'vitest';
import { Dispatcher } from './dispatcher.js';
import { TicketError, type TrelloCard } from './ticket.js';

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
    workspaceRoot: vi.fn().mockReturnValue('/root/work/aBcD1234'),
    writeAgentCredentials: vi.fn().mockResolvedValue('/root/env/aBcD1234.credentials.json'),
  };
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
  const dispatcher = new Dispatcher({
    trello: trello as never,
    herdr: herdr as never,
    git: git as never,
    projects: projects as never,
    config: {
      trello: {
        lists: { backlog: 'list-backlog', inProgress: 'list-progress', blocked: 'list-blocked' },
      },
      github: { owner: 'kostnerek', token: 'gh-secret-token' },
      paths: { root: '/root', claudeCredentials: '/creds' },
    } as never,
  });
  return { dispatcher, trello, herdr, git, projects };
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
      expect.objectContaining({ source: expect.objectContaining({ owner: 'kostnerek' }) }),
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

describe('Dispatcher across several repositories', () => {
  it('mirrors and checks out every repository of the project', async () => {
    const { dispatcher, git, projects } = build();
    projects.resolveProject.mockReturnValue(['platform', 'backoffice']);

    await dispatcher.claimAndStart(makeCard());

    expect(git.ensureMirror).toHaveBeenCalledTimes(2);
    expect(git.prepareWorkspace).toHaveBeenCalledTimes(2);
    expect(
      git.prepareWorkspace.mock.calls.map(
        ([params]) => (params as { source: { repo: string } }).source.repo,
      ),
    ).toEqual(['platform', 'backoffice']);
  });

  it('mounts the shared workspace root, not one repository', async () => {
    const { dispatcher, herdr, git } = build();
    git.workspaceRoot.mockReturnValue('/root/work/aBcD1234');

    await dispatcher.claimAndStart(makeCard());

    expect(herdr.createWorkspace).toHaveBeenCalledWith('aBcD1234', '/root/work/aBcD1234');
    const command = herdr.startAgent.mock.calls[0]![0].command as string;
    expect(command).toContain('-v /root/work/aBcD1234:/workspace');
  });

  it('sends a card naming an unknown project to Backlog without cloning anything', async () => {
    const { dispatcher, trello, git, projects } = build();
    projects.resolveProject.mockImplementation(() => {
      throw new TicketError('No project named "typo".');
    });

    await dispatcher.claimAndStart(makeCard());

    expect(trello.moveCard).toHaveBeenCalledWith('card-1', 'list-backlog');
    expect(git.ensureMirror).not.toHaveBeenCalled();
  });
});
