import { describe, expect, it } from 'vitest';
import { buildAgentCommand, buildPrompt } from './prompt.js';
import type { Ticket } from './ticket.js';

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    cardId: 'card-1',
    shortLink: 'aBcD1234',
    title: 'Add HELLO file',
    description: 'Create HELLO.md at the repo root.',
    repo: 'demo',
    baseBranch: 'main',
    branch: 'fiesta/aBcD1234-add-hello-file',
    ...overrides,
  };
}

describe('buildPrompt', () => {
  it('includes the repo, base branch, working branch, title and description', () => {
    const prompt = buildPrompt(makeTicket(), 'kostnerek');

    expect(prompt).toContain('Repository: demo');
    expect(prompt).toContain('Base branch: main');
    expect(prompt).toContain('Working branch: fiesta/aBcD1234-add-hello-file');
    expect(prompt).toContain('Title: Add HELLO file');
    expect(prompt).toContain('Create HELLO.md at the repo root.');
  });

  it('tells the agent how to push and open the PR without a gh CLI', () => {
    const prompt = buildPrompt(makeTicket(), 'kostnerek');

    expect(prompt).toContain('https://github.com/kostnerek/demo.git');
    expect(prompt).toContain('git push -u origin HEAD');
    expect(prompt).toMatch(/no gh CLI/i);
    expect(prompt).toContain('GITHUB_OWNER (kostnerek)');
    expect(prompt).toContain('FIESTA_REPO (demo)');
  });
});

describe('buildAgentCommand', () => {
  function build(overrides: Partial<Parameters<typeof buildAgentCommand>[0]> = {}) {
    return buildAgentCommand({
      workspacePath: '/root/work/aBcD1234',
      claudeCredentials: '/creds',
      envFilePath: '/root/env/aBcD1234.env',
      prompt: buildPrompt(makeTicket(), 'kostnerek'),
      ...overrides,
    });
  }

  it('mounts only the credentials file, not the whole .claude directory', () => {
    const command = build();

    expect(command).toContain('-v /creds/.credentials.json:/home/agent/.claude/.credentials.json:ro');
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

  it('carries the prompt as base64 in FIESTA_PROMPT_B64 and it decodes back to buildPrompt output', () => {
    const prompt = buildPrompt(makeTicket(), 'kostnerek');
    const command = build({ prompt });

    const match = /FIESTA_PROMPT_B64=(\S+)/.exec(command);
    expect(match).not.toBeNull();
    const decoded = Buffer.from(match![1]!, 'base64').toString('utf8');
    expect(decoded).toBe(prompt);
  });
});
