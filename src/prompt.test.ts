import { describe, expect, it } from 'vitest';
import { buildAgentCommand, buildPrompt } from './prompt.js';
import type { RepoSource } from './repo-source.js';

function src(repo: string, owner = 'kostnerek'): RepoSource {
  return { dir: repo, owner, repo, localPath: null };
}
import type { Ticket } from './ticket.js';

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    cardId: 'card-1',
    shortLink: 'aBcD1234',
    title: 'Add HELLO file',
    description: 'Create HELLO.md at the repo root.',
    project: 'demo',
    baseBranch: 'main',
    branch: 'fiesta/aBcD1234-add-hello-file',
    ...overrides,
  };
}

describe('buildPrompt', () => {
  it('includes the project, base branch, working branch, title and description', () => {
    const prompt = buildPrompt(makeTicket(), 'kostnerek', [src('demo')]);

    expect(prompt).toContain('Project: demo');
    expect(prompt).toContain('Base branch: main');
    expect(prompt).toContain('Working branch: fiesta/aBcD1234-add-hello-file');
    expect(prompt).toContain('Title: Add HELLO file');
    expect(prompt).toContain('Create HELLO.md at the repo root.');
  });

  it('tells the agent how to push and open the PR without a gh CLI', () => {
    const prompt = buildPrompt(makeTicket(), 'kostnerek', [src('demo')]);

    expect(prompt).toContain('git push -u origin HEAD');
    expect(prompt).toMatch(/no gh CLI/i);
    expect(prompt).toContain('GITHUB_OWNER (kostnerek)');
    expect(prompt).toContain('FIESTA_REPOS');
  });
});

describe('buildAgentCommand', () => {
  function build(overrides: Partial<Parameters<typeof buildAgentCommand>[0]> = {}) {
    return buildAgentCommand({
      workspacePath: '/root/work/aBcD1234',
      credentialsPath: '/root/env/aBcD1234.credentials.json',
      envFilePath: '/root/env/aBcD1234.env',
      ...overrides,
    });
  }

  it('mounts only the credentials file, not the whole .claude directory', () => {
    const command = build();

    expect(command).toContain('.credentials.json:/home/agent/.claude/.credentials.json:ro');
    expect(command).not.toContain(':/home/agent/.claude:ro');
  });

  it('mounts the workspace path at /workspace', () => {
    const command = build();

    expect(command).toContain('-v /root/work/aBcD1234:/workspace');
  });

  it('passes the secrets through an env file, never on the command line', () => {
    const command = build();

    expect(command).toContain('--env-file /root/env/aBcD1234.env');
    expect(command).not.toContain('GITHUB_TOKEN');
    expect(command).not.toContain('gh-token');
  });

  it('stays short enough for a shell, carrying no prompt on the command line', () => {
    const command = build();

    expect(command).not.toContain('FIESTA_PROMPT_B64');
    expect(command.length).toBeLessThan(400);
  });
});

describe('buildPrompt across several repositories', () => {
  it('lists a checkout path per repository of the project', () => {
    const prompt = buildPrompt(makeTicket(), 'kostnerek', [src('platform'), src('backoffice')]);

    expect(prompt).toContain('/workspace/platform  ->  github.com/kostnerek/platform');
    expect(prompt).toContain('/workspace/backoffice  ->  github.com/kostnerek/backoffice');
    expect(prompt).toContain('FIESTA_REPOS');
  });

  it('tells the agent that leaving a repository untouched is normal', () => {
    const prompt = buildPrompt(makeTicket(), 'kostnerek', [src('platform'), src('backoffice')]);

    expect(prompt).toMatch(/Leaving one untouched is/);
    expect(prompt).toMatch(/one draft PR per changed repository/i);
  });
});

describe('buildAgentCommand ownership', () => {
  it('does not force a user, because Claude Code refuses to run as root', () => {
    const command = buildAgentCommand({
      workspacePath: '/root/work/aBcD1234',
      credentialsPath: '/root/env/aBcD1234.credentials.json',
      envFilePath: '/root/env/aBcD1234.env',
    });

    expect(command).not.toContain('--user');
  });

  it('mounts the per-ticket credentials copy, not the operator home file', () => {
    const command = buildAgentCommand({
      workspacePath: '/w',
      credentialsPath: '/root/env/aBcD1234.credentials.json',
      envFilePath: '/e',
    });

    expect(command).toContain(
      '-v /root/env/aBcD1234.credentials.json:/home/agent/.claude/.credentials.json:ro',
    );
  });
});

describe('buildAgentCommand stdin', () => {
  it('allocates a tty, so the session stays live and streams into the pane', () => {
    const command = buildAgentCommand({
      workspacePath: '/w',
      credentialsPath: '/c.json',
      envFilePath: '/e',
    });

    expect(command).toContain('docker run --rm -it');
  });
});
