import { describe, expect, it, vi } from 'vitest';
import { HerdrClient } from './herdr.js';

describe('HerdrClient', () => {
  it('creates a workspace with the label and cwd', async () => {
    const run = vi.fn().mockResolvedValue(
      JSON.stringify({
        id: 'cli:workspace:create',
        result: {
          type: 'workspace_created',
          workspace: { workspace_id: 'w2', label: 'aBcD1234', pane_count: 1, tab_count: 1 },
          tab: { tab_id: 'w2:t1', workspace_id: 'w2' },
          root_pane: { pane_id: 'w2:p1', workspace_id: 'w2', tab_id: 'w2:t1' },
        },
      }),
    );
    const client = new HerdrClient(run);

    const workspace = await client.createWorkspace('aBcD1234', '/work/aBcD1234');

    expect(workspace).toEqual({ id: 'w2', label: 'aBcD1234' });
    expect(run).toHaveBeenCalledWith([
      'workspace', 'create', '--cwd', '/work/aBcD1234', '--label', 'aBcD1234',
    ]);
  });

  it('finds a workspace by label', async () => {
    const run = vi.fn().mockResolvedValue(
      JSON.stringify({
        id: 'cli:workspace:list',
        result: {
          type: 'workspace_list',
          workspaces: [
            { workspace_id: 'w1', label: 'other' },
            { workspace_id: 'w2', label: 'aBcD1234' },
          ],
        },
      }),
    );
    await expect(new HerdrClient(run).findWorkspaceByLabel('aBcD1234')).resolves.toEqual({
      id: 'w2',
      label: 'aBcD1234',
    });
    expect(run).toHaveBeenCalledWith(['workspace', 'list']);
  });

  it('returns null when no workspace carries the label', async () => {
    const run = vi.fn().mockResolvedValue(
      JSON.stringify({ id: 'cli:workspace:list', result: { type: 'workspace_list', workspaces: [] } }),
    );
    await expect(new HerdrClient(run).findWorkspaceByLabel('nope')).resolves.toBeNull();
  });

  it('resolves the first pane id for a workspace', async () => {
    const run = vi.fn().mockResolvedValue(
      JSON.stringify({
        id: 'cli:pane:list',
        result: {
          type: 'pane_list',
          panes: [
            { pane_id: 'w2:p1', workspace_id: 'w2', agent_status: 'unknown' },
            { pane_id: 'w2:p2', workspace_id: 'w2', agent_status: 'unknown' },
          ],
        },
      }),
    );

    await expect(new HerdrClient(run).firstPaneId('w2')).resolves.toBe('w2:p1');
    expect(run).toHaveBeenCalledWith(['pane', 'list', '--workspace', 'w2']);
  });

  it('throws when a workspace has no panes', async () => {
    const run = vi.fn().mockResolvedValue(
      JSON.stringify({ id: 'cli:pane:list', result: { type: 'pane_list', panes: [] } }),
    );

    await expect(new HerdrClient(run).firstPaneId('w2')).rejects.toThrow(/w2/);
  });

  it('starts an agent by renaming and running a command in the workspace root pane', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify({
          id: 'cli:pane:list',
          result: { type: 'pane_list', panes: [{ pane_id: 'w2:p1', workspace_id: 'w2' }] },
        }),
      )
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('');

    const paneId = await new HerdrClient(run).startAgent({
      workspaceId: 'w2',
      name: 'DEV-1234',
      command: 'docker run --rm agent-image',
    });

    expect(paneId).toBe('w2:p1');
    expect(run).toHaveBeenNthCalledWith(1, ['pane', 'list', '--workspace', 'w2']);
    expect(run).toHaveBeenNthCalledWith(2, ['pane', 'rename', 'w2:p1', 'DEV-1234']);
    expect(run).toHaveBeenNthCalledWith(3, ['pane', 'run', 'w2:p1', 'docker run --rm agent-image']);
  });

  it('reads recent unwrapped pane output verbatim', async () => {
    const run = vi.fn().mockResolvedValue(' /work/aBcD1234 echo hi\nhi\n /work/aBcD1234 ');
    await expect(new HerdrClient(run).readPane('w2:p1')).resolves.toBe(
      ' /work/aBcD1234 echo hi\nhi\n /work/aBcD1234 ',
    );
    expect(run).toHaveBeenCalledWith(['pane', 'read', 'w2:p1', '--source', 'recent-unwrapped']);
  });

  it('reads pane status from the agent_status field', async () => {
    const run = vi.fn().mockResolvedValue(
      JSON.stringify({
        id: 'cli:pane:get',
        result: { type: 'pane_info', pane: { pane_id: 'w2:p1', agent_status: 'blocked' } },
      }),
    );
    await expect(new HerdrClient(run).paneStatus('w2:p1')).resolves.toBe('blocked');
    expect(run).toHaveBeenCalledWith(['pane', 'get', 'w2:p1']);
  });

  it('defaults pane status to unknown when the field is missing', async () => {
    const run = vi.fn().mockResolvedValue(
      JSON.stringify({ id: 'cli:pane:get', result: { type: 'pane_info', pane: { pane_id: 'w2:p1' } } }),
    );
    await expect(new HerdrClient(run).paneStatus('w2:p1')).resolves.toBe('unknown');
  });

  it('sends text verbatim to a pane', async () => {
    const run = vi.fn().mockResolvedValue('');
    await new HerdrClient(run).sendText('pane-1', 'use provider X');
    expect(run).toHaveBeenCalledWith(['pane', 'send-text', 'pane-1', 'use provider X']);
  });

  it('closes the workspace to kill it', async () => {
    const run = vi.fn().mockResolvedValue(
      JSON.stringify({ id: 'cli:workspace:close', result: { type: 'ok' } }),
    );
    await new HerdrClient(run).killWorkspace('w2');
    expect(run).toHaveBeenCalledWith(['workspace', 'close', 'w2']);
  });
});
