import { execFile } from 'node:child_process';
import { access, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Ticket } from './ticket.js';

const execFileAsync = promisify(execFile);

async function git(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function ensureMirror(params: {
  root: string;
  owner: string;
  repo: string;
  token: string;
}): Promise<string> {
  const mirrorPath = join(params.root, 'repos', params.repo);
  const remote = `https://x-access-token:${params.token}@github.com/${params.owner}/${params.repo}.git`;

  if (await exists(mirrorPath)) {
    await git(['-C', mirrorPath, 'fetch', '--prune', 'origin']);
    return mirrorPath;
  }

  await mkdir(join(params.root, 'repos'), { recursive: true });
  await git(['clone', remote, mirrorPath]);
  return mirrorPath;
}

export async function prepareWorkspace(params: {
  root: string;
  mirrorPath: string;
  ticket: Ticket;
}): Promise<string> {
  const workspacePath = join(params.root, 'work', params.ticket.shortLink);
  if (await exists(workspacePath)) {
    return workspacePath;
  }

  await mkdir(join(params.root, 'work'), { recursive: true });
  await git(['clone', '--local', params.mirrorPath, workspacePath]);
  await git(['-C', workspacePath, 'checkout', '-B', params.ticket.branch, params.ticket.baseBranch]);
  return workspacePath;
}

export async function removeWorkspace(params: { root: string; shortLink: string }): Promise<void> {
  await rm(join(params.root, 'work', params.shortLink), { recursive: true, force: true });
}
