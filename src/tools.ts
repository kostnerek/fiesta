import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const MINIMUM_NODE_MAJOR = 22;

export type ToolRunner = (command: string, args: string[]) => Promise<void>;

export type Tool = {
  name: string;
  probe: { command: string; args: string[] };
  install?: { command: string; args: string[]; describe: string };
  hint: string;
};

export const REQUIRED_TOOLS: Tool[] = [
  {
    name: 'git',
    probe: { command: 'git', args: ['--version'] },
    hint: 'Install git with your system package manager, then run setup again.',
  },
  {
    name: 'docker',
    probe: { command: 'docker', args: ['info'] },
    hint: 'Install Docker and make sure the daemon is running, then run setup again.',
  },
  {
    name: 'claude',
    probe: { command: 'claude', args: ['--version'] },
    install: {
      command: 'npm',
      args: ['install', '-g', '@anthropic-ai/claude-code'],
      describe: 'npm install -g @anthropic-ai/claude-code',
    },
    hint: 'Install Claude Code, then run setup again.',
  },
  {
    name: 'herdr',
    probe: { command: 'herdr', args: ['--version'] },
    install: {
      command: 'sh',
      args: ['-c', 'curl -fsSL https://herdr.dev/install.sh | sh'],
      describe: 'curl -fsSL https://herdr.dev/install.sh | sh',
    },
    hint: 'Install herdr from https://herdr.dev/docs/install/, then run setup again.',
  },
];

export const defaultToolRunner: ToolRunner = async (command, args) => {
  await execFileAsync(command, args);
};

export async function findMissingTools(tools: Tool[], run: ToolRunner): Promise<Tool[]> {
  const missing: Tool[] = [];
  for (const tool of tools) {
    try {
      await run(tool.probe.command, tool.probe.args);
    } catch {
      missing.push(tool);
    }
  }
  return missing;
}

export function unsupportedNodeVersion(version: string): string | null {
  const major = Number(version.split('.')[0]);
  if (!Number.isFinite(major) || major < MINIMUM_NODE_MAJOR) {
    return `Fiesta needs Node ${MINIMUM_NODE_MAJOR} or newer, but this is Node ${version}.`;
  }
  return null;
}

export function credentialsFile(directory: string): string {
  return join(directory, '.credentials.json');
}

export async function hasCredentialsFile(directory: string): Promise<boolean> {
  try {
    await access(credentialsFile(directory));
    return true;
  } catch {
    return false;
  }
}

export function survivesUnraidReboot(path: string): boolean {
  return path.startsWith('/mnt/') || path.startsWith('/boot/');
}
