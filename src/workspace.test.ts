import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeEach, describe, expect, it } from 'vitest';
import { prepareWorkspace, removeWorkspace } from './workspace.js';
import type { Ticket } from './ticket.js';

const run = promisify(execFile);

let root: string;
let mirrorPath: string;

const ticket: Ticket = {
  cardId: 'card-1',
  shortLink: 'aBcD1234',
  title: 'Add HELLO file',
  description: '',
  repo: 'demo',
  baseBranch: 'main',
  branch: 'fiesta/aBcD1234-add-hello-file',
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fiesta-'));
  mirrorPath = join(root, 'repos', 'demo');
  await run('git', ['init', '--initial-branch=main', mirrorPath]);
  await writeFile(join(mirrorPath, 'README.md'), 'demo\n');
  await run('git', ['-C', mirrorPath, 'add', '.']);
  await run('git', ['-C', mirrorPath, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init']);
});

describe('prepareWorkspace', () => {
  it('clones the mirror and checks out the ticket branch', async () => {
    const path = await prepareWorkspace({ root, mirrorPath, ticket });

    expect(await readFile(join(path, 'README.md'), 'utf8')).toBe('demo\n');
    const { stdout } = await run('git', ['-C', path, 'rev-parse', '--abbrev-ref', 'HEAD']);
    expect(stdout.trim()).toBe('fiesta/aBcD1234-add-hello-file');
  });

  it('is idempotent — a second call reuses the same checkout', async () => {
    const first = await prepareWorkspace({ root, mirrorPath, ticket });
    await writeFile(join(first, 'scratch.txt'), 'kept\n');
    const second = await prepareWorkspace({ root, mirrorPath, ticket });

    expect(second).toBe(first);
    expect(await readFile(join(second, 'scratch.txt'), 'utf8')).toBe('kept\n');
  });

  it('checks out from a non-default base branch', async () => {
    await run('git', ['-C', mirrorPath, 'checkout', '-b', 'develop']);
    await writeFile(join(mirrorPath, 'DEVELOP.md'), 'from develop\n');
    await run('git', ['-C', mirrorPath, 'add', '.']);
    await run('git', [
      '-C',
      mirrorPath,
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=t',
      'commit',
      '-m',
      'develop commit',
    ]);
    await run('git', ['-C', mirrorPath, 'checkout', 'main']);

    const developTicket: Ticket = {
      ...ticket,
      shortLink: 'devBranch1',
      baseBranch: 'develop',
      branch: 'fiesta/devBranch1-add-hello-file',
    };

    const path = await prepareWorkspace({ root, mirrorPath, ticket: developTicket });

    const { stdout } = await run('git', ['-C', path, 'rev-parse', '--abbrev-ref', 'HEAD']);
    expect(stdout.trim()).toBe('fiesta/devBranch1-add-hello-file');
    expect(await readFile(join(path, 'DEVELOP.md'), 'utf8')).toBe('from develop\n');
  });
});

describe('removeWorkspace', () => {
  it('rejects a shortLink that escapes the work directory', async () => {
    const sentinelDir = join(root, 'sentinel');
    await mkdir(sentinelDir, { recursive: true });
    await writeFile(join(sentinelDir, 'keep.txt'), 'keep\n');

    await expect(removeWorkspace({ root, shortLink: join('..', 'sentinel') })).rejects.toThrow();

    expect(await readFile(join(sentinelDir, 'keep.txt'), 'utf8')).toBe('keep\n');
  });
});
