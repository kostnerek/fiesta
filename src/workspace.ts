import { execFile } from 'node:child_process';
import { access, chmod, chown, copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { RepoSource } from './repo-source.js';
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

export function mirrorPathFor(root: string, source: RepoSource): string {
  return join(root, 'repos', source.owner, source.repo);
}

export async function ensureMirror(params: {
  root: string;
  source: RepoSource;
  token: string;
}): Promise<string> {
  const mirrorPath = mirrorPathFor(params.root, params.source);
  await mkdir(join(params.root, 'repos', params.source.owner), { recursive: true });

  if (params.source.localPath) {
    if (!(await exists(mirrorPath))) {
      await git(['clone', '--mirror', params.source.localPath, mirrorPath]);
    }
    await git([
      '-C',
      mirrorPath,
      'fetch',
      '--prune',
      params.source.localPath,
      '+refs/remotes/origin/*:refs/heads/*',
    ]);
    return mirrorPath;
  }

  const { env, secrets } = tokenCredentials(params.token);
  const remote = remoteUrl(params.source.owner, params.source.repo);

  if (await exists(mirrorPath)) {
    await git(['-C', mirrorPath, 'fetch', '--prune', 'origin'], { env, secrets });
    return mirrorPath;
  }

  await git(['clone', '--mirror', remote, mirrorPath], { env, secrets });
  return mirrorPath;
}

export function remoteUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}.git`;
}

export function workspaceRoot(root: string, shortLink: string): string {
  return join(root, 'work', shortLink);
}

export async function prepareWorkspace(params: {
  root: string;
  mirrorPath: string;
  source: RepoSource;
  ticket: Ticket;
}): Promise<string> {
  const checkoutPath = join(workspaceRoot(params.root, params.ticket.shortLink), params.source.dir);
  if (await exists(checkoutPath)) {
    return checkoutPath;
  }

  await mkdir(workspaceRoot(params.root, params.ticket.shortLink), { recursive: true });
  await git(['clone', '--local', params.mirrorPath, checkoutPath]);
  await git([
    '-C',
    checkoutPath,
    'checkout',
    '-B',
    params.ticket.branch,
    `origin/${params.ticket.baseBranch}`,
  ]);
  await git([
    '-C',
    checkoutPath,
    'remote',
    'set-url',
    'origin',
    remoteUrl(params.source.owner, params.source.repo),
  ]);
  return checkoutPath;
}

export const AGENT_UID = 1001;
export const AGENT_GID = 1001;

export function agentEnvPath(root: string, shortLink: string): string {
  return join(root, 'env', `${shortLink}.env`);
}

export function agentCredentialsPath(root: string, shortLink: string): string {
  return join(root, 'env', `${shortLink}.credentials.json`);
}

export async function writeAgentCredentials(params: {
  root: string;
  shortLink: string;
  source: string;
}): Promise<string> {
  const target = agentCredentialsPath(params.root, params.shortLink);
  await mkdir(join(params.root, 'env'), { recursive: true, mode: 0o700 });
  await copyFile(params.source, target);
  await chmod(target, 0o600);
  try {
    await chown(target, AGENT_UID, AGENT_GID);
  } catch {
    return target;
  }
  return target;
}

export async function writeAgentEnvFile(params: {
  root: string;
  owner: string;
  token: string;
  sources: RepoSource[];
  prompt: string;
  ticket: Ticket;
}): Promise<string> {
  const path = agentEnvPath(params.root, params.ticket.shortLink);
  const body = [
    `GITHUB_TOKEN=${params.token}`,
    `GITHUB_OWNER=${params.owner}`,
    `FIESTA_PROJECT=${params.ticket.project}`,
    `FIESTA_REPOS=${params.sources.map((source) => `${source.owner}/${source.repo}`).join(',')}`,
    `FIESTA_BASE_BRANCH=${params.ticket.baseBranch}`,
    `FIESTA_PROMPT_B64=${Buffer.from(params.prompt, 'utf8').toString('base64')}`,
    '',
  ].join('\n');

  await mkdir(join(params.root, 'env'), { recursive: true, mode: 0o700 });
  await writeFile(path, body, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

export async function removeWorkspace(params: { root: string; shortLink: string }): Promise<void> {
  const workBase = resolve(params.root, 'work');
  const target = resolve(workBase, params.shortLink);

  if (!target.startsWith(workBase + sep)) {
    throw new Error(`Refusing to remove path outside the work directory: ${params.shortLink}`);
  }

  await rm(target, { recursive: true, force: true });

  await rm(join(params.root, 'state', `${params.shortLink}.comments`), { force: true });

  const envBase = resolve(params.root, 'env');
  for (const path of [
    agentEnvPath(params.root, params.shortLink),
    agentCredentialsPath(params.root, params.shortLink),
  ]) {
    if (resolve(path).startsWith(envBase + sep)) {
      await rm(path, { force: true });
    }
  }
}
