import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { HerdrClient } from './herdr.js';

type Envelope = { id: string; result: Record<string, unknown> };

function fixtureText(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../test/fixtures/herdr/${name}.json`, import.meta.url)), 'utf8');
}

function fixture(name: string): Envelope {
  return JSON.parse(fixtureText(name)) as Envelope;
}

function respond(name: string, patch: (envelope: Envelope) => void = () => {}): string {
  const envelope = fixture(name);
  patch(envelope);
  return JSON.stringify(envelope);
}

describe('HerdrClient', () => {
  it('creates a workspace with the label and cwd', async () => {
    const run = vi.fn().mockResolvedValue(respond('workspace-create'));
    const client = new HerdrClient(run);

    const workspace = await client.createWorkspace('probe', '/private/tmp');

    expect(workspace).toEqual({ id: 'w2', label: 'probe' });
    expect(run).toHaveBeenCalledWith([
      'workspace', 'create', '--cwd', '/private/tmp', '--label', 'probe',
    ]);
  });

  it('finds a workspace by label', async () => {
    const run = vi.fn().mockResolvedValue(respond('workspace-list'));

    await expect(new HerdrClient(run).findWorkspaceByLabel('probe')).resolves.toEqual({
      id: 'w2',
      label: 'probe',
    });
    expect(run).toHaveBeenCalledWith(['workspace', 'list']);
  });

  it('returns null when no workspace carries the label', async () => {
    const run = vi.fn().mockResolvedValue(respond('workspace-list'));
    await expect(new HerdrClient(run).findWorkspaceByLabel('nope')).resolves.toBeNull();
  });

  it('resolves the first pane id for a workspace', async () => {
    const run = vi.fn().mockResolvedValue(respond('pane-list-workspace'));

    await expect(new HerdrClient(run).firstPaneId('w2')).resolves.toBe('w2:p1');
    expect(run).toHaveBeenCalledWith(['pane', 'list', '--workspace', 'w2']);
  });

  it('takes the first pane when a workspace has several', async () => {
    const run = vi.fn().mockResolvedValue(respond('pane-list'));
    await expect(new HerdrClient(run).firstPaneId('w1')).resolves.toBe('w1:p1');
  });

  it('throws when a workspace has no panes', async () => {
    const run = vi.fn().mockResolvedValue(
      respond('pane-list-workspace', (envelope) => {
        envelope.result.panes = [];
      }),
    );

    await expect(new HerdrClient(run).firstPaneId('w2')).rejects.toThrow(/w2/);
  });

  it('starts an agent by renaming and running a command in the workspace root pane', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(respond('pane-list-workspace'))
      .mockResolvedValueOnce(respond('pane-rename'))
      .mockResolvedValueOnce(readFileSync(fileURLToPath(new URL('../test/fixtures/herdr/pane-run.json', import.meta.url)), 'utf8'));

    const paneId = await new HerdrClient(run).startAgent({
      workspaceId: 'w2',
      name: 'aBcD1234',
      command: 'docker run --rm agent-image',
    });

    expect(paneId).toBe('w2:p1');
    expect(run).toHaveBeenNthCalledWith(1, ['pane', 'list', '--workspace', 'w2']);
    expect(run).toHaveBeenNthCalledWith(2, ['pane', 'rename', 'w2:p1', 'aBcD1234']);
    expect(run).toHaveBeenNthCalledWith(3, ['pane', 'run', 'w2:p1', 'docker run --rm agent-image']);
  });

  it('reads recent unwrapped pane output verbatim', async () => {
    const paneOutput = readFileSync(
      fileURLToPath(new URL('../test/fixtures/herdr/pane-read.json', import.meta.url)),
      'utf8',
    );
    const run = vi.fn().mockResolvedValue(paneOutput);

    await expect(new HerdrClient(run).readPane('w2:p1')).resolves.toBe(paneOutput);
    expect(run).toHaveBeenCalledWith(['pane', 'read', 'w2:p1', '--source', 'recent-unwrapped']);
  });

  it('reads pane status from the agent_status field', async () => {
    const run = vi.fn().mockResolvedValue(
      respond('pane-get', (envelope) => {
        (envelope.result as { pane: { agent_status: string } }).pane.agent_status = 'blocked';
      }),
    );

    await expect(new HerdrClient(run).paneStatus('w2:p1')).resolves.toBe('blocked');
    expect(run).toHaveBeenCalledWith(['pane', 'get', 'w2:p1']);
  });

  it('defaults pane status to unknown when the field is missing', async () => {
    const run = vi.fn().mockResolvedValue(
      respond('pane-get', (envelope) => {
        delete (envelope.result as { pane: Record<string, unknown> }).pane.agent_status;
      }),
    );

    await expect(new HerdrClient(run).paneStatus('w2:p1')).resolves.toBe('unknown');
  });

  it('closes the workspace to kill it', async () => {
    const run = vi.fn().mockResolvedValue(respond('workspace-close'));

    await new HerdrClient(run).killWorkspace('w2');

    expect(run).toHaveBeenCalledWith(['workspace', 'close', 'w2']);
  });
});
