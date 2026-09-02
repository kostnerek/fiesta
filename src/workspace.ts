import { execFile } from 'node:child_process';
import { access, mkdir, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { Ticket } from './ticket.js';

const execFileAsync = promisify(execFile);

function redact(value: string, secrets: string[]): string {
  return secrets.reduce((acc, secret) => (secret ? acc.split(secret).join('[REDACTED]') : acc), value);
}

function redactError(err: unknown, secrets: string[]): unknown {
  if (!(err instanceof Error) || secrets.length === 0) {
    return err;
  }
  const fields = err as unknown as Record<string, unknown>;
  for (const key of ['message', 'cmd', 'stdout', 'stderr', 'stack', 'spawnargs']) {
    const value = fields[key];
    if (typeof value === 'string') {
      fields[key] = redact(value, secrets);
    } else if (Array.isArray(value)) {
      fields[key] = value.map((item) => (typeof item === 'string' ? redact(item, secrets) : item));
    }
  }
  return err;
}

async function git(
  args: string[],
  options: { secrets?: string[]; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  const { secrets = [], env } = options;
  try {
    const { stdout } = await execFileAsync('git', args, {
      maxBuffer: 32 * 1024 * 1024,
      ...(env ? { env } : {}),
    });
    return stdout;
  } catch (err) {
    throw redactError(err, secrets);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function tokenCredentials(token: string): {
  env: NodeJS.ProcessEnv;
  secrets: string[];
} {
  const credentials = Buffer.from(`x-access-token:${token}`).toString('base64');
  const headerValue = `AUTHORIZATION: basic ${credentials}`;
  return {
    env: {
      ...process.env,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraHeader',
      GIT_CONFIG_VALUE_0: headerValue,
    },
    secrets: [token, credentials],
  };
}

export async function ensureMirror(params: {
  root: string;
  owner: string;
  repo: string;
  token: string;
}): Promise<string> {
  const mirrorPath = join(params.root, 'repos', params.repo);
  const remote = `https://github.com/${params.owner}/${params.repo}.git`;
  const { env, secrets } = tokenCredentials(params.token);

  if (await exists(mirrorPath)) {
    await git(['-C', mirrorPath, 'fetch', '--prune', 'origin'], { env, secrets });
    return mirrorPath;
  }

  await mkdir(join(params.root, 'repos'), { recursive: true });
  await git(['clone', remote, mirrorPath], { env, secrets });
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
  await git([
    '-C',
    workspacePath,
    'checkout',
    '-B',
    params.ticket.branch,
    `origin/${params.ticket.baseBranch}`,
  ]);
  return workspacePath;
}

export async function removeWorkspace(params: { root: string; shortLink: string }): Promise<void> {
  const workBase = resolve(params.root, 'work');
  const target = resolve(workBase, params.shortLink);

  if (!target.startsWith(workBase + sep)) {
    throw new Error(`Refusing to remove path outside the work directory: ${params.shortLink}`);
  }

  await rm(target, { recursive: true, force: true });
}
