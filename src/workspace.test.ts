import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeEach, describe, expect, it } from 'vitest';
import { prepareWorkspace } from './workspace.js';
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
});
