import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type PaneStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';
export type HerdrWorkspace = { id: string; label: string };

export type HerdrRunner = (args: string[]) => Promise<string>;

type RawWorkspace = { workspace_id: string; label: string };
type RawPane = { pane_id: string; agent_status?: PaneStatus };
type HerdrEnvelope<T> = { result: T };

const defaultRunner: HerdrRunner = async (args) => {
  const { stdout } = await execFileAsync('herdr', args, { maxBuffer: 32 * 1024 * 1024 });
  return stdout;
};

function toWorkspace(raw: RawWorkspace): HerdrWorkspace {
  return { id: raw.workspace_id, label: raw.label };
}

export class HerdrClient {
  constructor(private readonly run: HerdrRunner = defaultRunner) {}

  private async result<T>(args: string[]): Promise<T> {
    const envelope = JSON.parse(await this.run(args)) as HerdrEnvelope<T>;
    return envelope.result;
  }

  async createWorkspace(label: string, cwd: string): Promise<HerdrWorkspace> {
    const { workspace } = await this.result<{ workspace: RawWorkspace }>([
      'workspace', 'create', '--cwd', cwd, '--label', label,
    ]);
    return toWorkspace(workspace);
  }

  async findWorkspaceByLabel(label: string): Promise<HerdrWorkspace | null> {
    const { workspaces } = await this.result<{ workspaces: RawWorkspace[] }>(['workspace', 'list']);
    const found = workspaces.find((workspace) => workspace.label === label);
    return found ? toWorkspace(found) : null;
  }

  async firstPaneId(workspaceId: string): Promise<string> {
    const { panes } = await this.result<{ panes: RawPane[] }>([
      'pane', 'list', '--workspace', workspaceId,
    ]);
    const [first] = panes;
    if (!first) {
      throw new Error(`workspace ${workspaceId} has no panes`);
    }
    return first.pane_id;
  }

  async startAgent(params: { workspaceId: string; name: string; command: string }): Promise<string> {
    const paneId = await this.firstPaneId(params.workspaceId);
    await this.run(['pane', 'rename', paneId, params.name]);
    await this.run(['pane', 'run', paneId, params.command]);
    return paneId;
  }

  readPane(paneId: string): Promise<string> {
    return this.run(['pane', 'read', paneId, '--source', 'recent-unwrapped']);
  }

  async paneStatus(paneId: string): Promise<PaneStatus> {
    const { pane } = await this.result<{ pane: RawPane }>(['pane', 'get', paneId]);
    return pane.agent_status ?? 'unknown';
  }

  async sendText(paneId: string, text: string): Promise<void> {
    await this.run(['pane', 'send-text', paneId, text]);
  }

  async killWorkspace(workspaceId: string): Promise<void> {
    await this.run(['workspace', 'close', workspaceId]);
  }
}
