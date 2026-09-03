import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect, promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  agentEnvPath,
  ensureMirror,
  prepareWorkspace,
  removeWorkspace,
  writeAgentEnvFile,
} from './workspace.js';
import type { Ticket } from './ticket.js';

const run = promisify(execFile);

const OWNER = 'someowner';
const REPO = 'demo';
const SOURCE = { dir: REPO, owner: OWNER, repo: REPO, localPath: null };

let root: string;
let mirrorPath: string;
let originPath: string;
let originalGitConfigGlobal: string | undefined;

const ticket: Ticket = {
  cardId: 'card-1',
  shortLink: 'aBcD1234',
  title: 'Add HELLO file',
  description: '',
  project: REPO,
  baseBranch: 'main',
  branch: 'fiesta/aBcD1234-add-hello-file',
};

async function commit(repoPath: string, message: string): Promise<void> {
  await run('git', ['-C', repoPath, 'add', '.']);
  await run('git', [
    '-C', repoPath, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', message,
  ]);
}

async function buildOrigin(): Promise<void> {
  await run('git', ['init', '--initial-branch=main', originPath]);
  await writeFile(join(originPath, 'README.md'), 'demo\n');
  await commit(originPath, 'init');
  await run('git', ['-C', originPath, 'checkout', '-b', 'develop']);
  await writeFile(join(originPath, 'DEVELOP.md'), 'from develop\n');
  await commit(originPath, 'develop commit');
  await run('git', ['-C', originPath, 'checkout', 'main']);
}

async function redirectGitHubToOrigin(): Promise<void> {
  const configPath = join(root, 'gitconfig');
  await writeFile(
    configPath,
    `[url "${originPath}"]\n\tinsteadOf = https://github.com/${OWNER}/${REPO}.git\n`,
  );
  originalGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = configPath;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fiesta-'));
  originPath = join(root, 'origin', REPO);
  await mkdir(join(root, 'origin'), { recursive: true });
  await buildOrigin();
  await redirectGitHubToOrigin();
  mirrorPath = await ensureMirror({ root, source: SOURCE, token: 'unused-token' });
});

afterEach(() => {
  if (originalGitConfigGlobal === undefined) {
    delete process.env.GIT_CONFIG_GLOBAL;
  } else {
    process.env.GIT_CONFIG_GLOBAL = originalGitConfigGlobal;
  }
});

describe('prepareWorkspace', () => {
  it('clones the mirror and checks out the ticket branch', async () => {
    const path = await prepareWorkspace({ root, mirrorPath, source: SOURCE, ticket });

    expect(await readFile(join(path, 'README.md'), 'utf8')).toBe('demo\n');
    const { stdout } = await run('git', ['-C', path, 'rev-parse', '--abbrev-ref', 'HEAD']);
    expect(stdout.trim()).toBe('fiesta/aBcD1234-add-hello-file');
  });

  it('repoints origin at GitHub so the agent can push from inside the container', async () => {
    const path = await prepareWorkspace({ root, mirrorPath, source: SOURCE, ticket });

    const { stdout } = await run('git', ['-C', path, 'config', '--get', 'remote.origin.url']);
    expect(stdout.trim()).toBe(`https://github.com/${OWNER}/${REPO}.git`);
    expect(stdout.trim()).not.toContain(root);
  });

  it('is idempotent — a second call reuses the same checkout', async () => {
    const first = await prepareWorkspace({ root, mirrorPath, source: SOURCE, ticket });
    await writeFile(join(first, 'scratch.txt'), 'kept\n');
    const second = await prepareWorkspace({ root, mirrorPath, source: SOURCE, ticket });

    expect(second).toBe(first);
    expect(await readFile(join(second, 'scratch.txt'), 'utf8')).toBe('kept\n');
  });

  it('checks out from a non-default base branch of a mirror ensureMirror actually produced', async () => {
    const developTicket: Ticket = {
      ...ticket,
      shortLink: 'devBranch1',
      baseBranch: 'develop',
      branch: 'fiesta/devBranch1-add-hello-file',
    };

    const path = await prepareWorkspace({ root, mirrorPath, source: SOURCE, ticket: developTicket });

    const { stdout } = await run('git', ['-C', path, 'rev-parse', '--abbrev-ref', 'HEAD']);
    expect(stdout.trim()).toBe('fiesta/devBranch1-add-hello-file');
    expect(await readFile(join(path, 'DEVELOP.md'), 'utf8')).toBe('from develop\n');
  });
});

describe('ensureMirror', () => {
  it('mirrors every branch of the remote, not only the default one', async () => {
    const { stdout } = await run('git', [
      '-C', mirrorPath, 'for-each-ref', '--format=%(refname)', 'refs/heads',
    ]);
    expect(stdout.split('\n').map((line) => line.trim())).toEqual(
      expect.arrayContaining(['refs/heads/main', 'refs/heads/develop']),
    );
  });

  it('fetches into an existing mirror instead of recloning', async () => {
    await writeFile(join(originPath, 'LATER.md'), 'later\n');
    await commit(originPath, 'later commit');

    const again = await ensureMirror({ root, source: SOURCE, token: 'unused-token' });

    expect(again).toBe(mirrorPath);
    const path = await prepareWorkspace({ root, mirrorPath, source: SOURCE, ticket });
    expect(await readFile(join(path, 'LATER.md'), 'utf8')).toBe('later\n');
  });
});

describe('writeAgentEnvFile', () => {
  it('writes the agent secrets to an owner-only file outside the mounted workspace', async () => {
    const path = await writeAgentEnvFile({ root, owner: OWNER, token: 'gh-secret', sources: [SOURCE], ticket });

    expect(path).toBe(agentEnvPath(root, ticket.shortLink));
    expect(path.startsWith(join(root, 'work'))).toBe(false);
    const body = await readFile(path, 'utf8');
    expect(body).toContain('GITHUB_TOKEN=gh-secret');
    expect(body).toContain(`GITHUB_OWNER=${OWNER}`);
    expect(body).toContain(`FIESTA_REPOS=${OWNER}/${REPO}`);
    expect(body).toContain(`FIESTA_PROJECT=${REPO}`);
    expect(body).toContain('FIESTA_BASE_BRANCH=main');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});

describe('removeWorkspace', () => {
  it('deletes the token-bearing env file along with the checkout', async () => {
    await prepareWorkspace({ root, mirrorPath, source: SOURCE, ticket });
    const envPath = await writeAgentEnvFile({ root, owner: OWNER, token: 'gh-secret', sources: [SOURCE], ticket });

    await removeWorkspace({ root, shortLink: ticket.shortLink });

    await expect(stat(envPath)).rejects.toThrow();
  });

  it('rejects a shortLink that escapes the work directory', async () => {
    const sentinelDir = join(root, 'sentinel');
    await mkdir(sentinelDir, { recursive: true });
    await writeFile(join(sentinelDir, 'keep.txt'), 'keep\n');

    await expect(removeWorkspace({ root, shortLink: join('..', 'sentinel') })).rejects.toThrow();

    expect(await readFile(join(sentinelDir, 'keep.txt'), 'utf8')).toBe('keep\n');
  });
});

describe('ensureMirror credential handling', () => {
  const originalPath = process.env.PATH;

  afterEach(() => {
    process.env.PATH = originalPath;
  });

  it('does not leak the token when the git binary cannot be spawned', async () => {
    const emptyBinDir = await mkdtemp(join(tmpdir(), 'fiesta-empty-bin-'));
    process.env.PATH = emptyBinDir;

    const token = 'SECRETVALUE123';
    let caught: unknown;
    try {
      await ensureMirror({ root, source: SOURCE, token });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    const credentials = Buffer.from(`x-access-token:${token}`).toString('base64');
    const serialized = JSON.stringify(caught, Object.getOwnPropertyNames(caught as object));
    const inspected = inspect(caught);

    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(credentials);
    expect(inspected).not.toContain(token);
    expect(inspected).not.toContain(credentials);
  });
});

describe('ensureMirror from a clone already on the machine', () => {
  it('mirrors a working clone that has both local and remote-tracking branches', async () => {
    const localClone = join(root, 'their-checkout');
    await run('git', ['clone', originPath, localClone]);
    await run('git', ['-C', localClone, 'config', 'user.email', 't@t']);
    await run('git', ['-C', localClone, 'config', 'user.name', 't']);

    const source = { dir: REPO, owner: OWNER, repo: REPO, localPath: localClone };
    const mirror = await ensureMirror({ root, source, token: 'unused-token' });

    const { stdout } = await run('git', ['-C', mirror, 'branch', '--list']);
    expect(stdout).toMatch(/main/);
  });

  it('branches from the remote state, not from unpushed local commits', async () => {
    const localClone = join(root, 'their-checkout-2');
    await run('git', ['clone', originPath, localClone]);
    await run('git', ['-C', localClone, 'config', 'user.email', 't@t']);
    await run('git', ['-C', localClone, 'config', 'user.name', 't']);
    await writeFile(join(localClone, 'UNPUSHED.md'), 'local only\n');
    await run('git', ['-C', localClone, 'add', '.']);
    await run('git', ['-C', localClone, 'commit', '-m', 'unpushed work']);

    const source = { dir: REPO, owner: OWNER, repo: REPO, localPath: localClone };
    const mirror = await ensureMirror({ root, source, token: 'unused-token' });
    const path = await prepareWorkspace({ root, mirrorPath: mirror, source, ticket });

    await expect(stat(join(path, 'UNPUSHED.md'))).rejects.toThrow();
  });

  it('picks up a branch the developer never checked out locally', async () => {
    await run('git', ['-C', originPath, 'branch', 'release']);
    const localClone = join(root, 'their-checkout-3');
    await run('git', ['clone', originPath, localClone]);

    const source = { dir: REPO, owner: OWNER, repo: REPO, localPath: localClone };
    const mirror = await ensureMirror({ root, source, token: 'unused-token' });

    const { stdout } = await run('git', ['-C', mirror, 'branch', '--list', 'release']);
    expect(stdout.trim()).toMatch(/release/);
  });
});
