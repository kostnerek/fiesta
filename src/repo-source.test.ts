import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  findDuplicateDirs,
  findGitRepos,
  isPathEntry,
  parseGitHubRef,
  parseOriginUrl,
  readOrigin,
  resolveRepoSource,
  type RepoSource,
} from './repo-source.js';

const run = promisify(execFile);

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fiesta-scan-'));
});

async function makeRepo(path: string, origin?: string): Promise<string> {
  await mkdir(path, { recursive: true });
  await run('git', ['init', '--initial-branch=main', path]);
  if (origin) {
    await run('git', ['-C', path, 'remote', 'add', 'origin', origin]);
  }
  return path;
}

describe('isPathEntry', () => {
  it.each([
    ['/mnt/user/repos/platform', true],
    ['./platform', true],
    ['~/repos/platform', true],
    ['platform', false],
    ['t-soft-io/platform', false],
  ])('%s -> %s', (entry, expected) => {
    expect(isPathEntry(entry)).toBe(expected);
  });
});

describe('parseOriginUrl', () => {
  it.each([
    ['git@github.com:t-soft-io/platform.git', 't-soft-io', 'platform'],
    ['https://github.com/t-soft-io/platform.git', 't-soft-io', 'platform'],
    ['https://github.com/kostnerek/fiesta', 'kostnerek', 'fiesta'],
  ])('%s -> %s/%s', (url, owner, repo) => {
    expect(parseOriginUrl(url)).toEqual({ owner, repo });
  });

  it('refuses a remote it cannot read an owner out of', () => {
    expect(() => parseOriginUrl('/some/local/path')).toThrow(/Cannot read an owner/);
  });
});

describe('parseGitHubRef', () => {
  it('applies the default owner to a bare name', () => {
    expect(parseGitHubRef('fiesta', 'kostnerek')).toEqual({ owner: 'kostnerek', repo: 'fiesta' });
  });

  it('takes the owner from owner/repo', () => {
    expect(parseGitHubRef('t-soft-io/platform', 'kostnerek')).toEqual({
      owner: 't-soft-io',
      repo: 'platform',
    });
  });

  it('rejects anything deeper', () => {
    expect(() => parseGitHubRef('a/b/c', 'kostnerek')).toThrow(/not a repository name/);
  });
});

describe('readOrigin', () => {
  it('reads the remote of a real clone', async () => {
    const path = await makeRepo(join(root, 'demo'), 'git@github.com:t-soft-io/platform.git');
    await expect(readOrigin(path)).resolves.toBe('git@github.com:t-soft-io/platform.git');
  });

  it('explains that a repo without origin cannot be pushed from', async () => {
    const path = await makeRepo(join(root, 'no-origin'));
    await expect(readOrigin(path)).rejects.toThrow(/no "origin" remote/);
  });
});

describe('resolveRepoSource', () => {
  it('derives owner and repo from a local clone rather than the default owner', async () => {
    const path = await makeRepo(join(root, 'platform'), 'git@github.com:t-soft-io/platform.git');

    await expect(resolveRepoSource(path, 'kostnerek')).resolves.toEqual({
      dir: 'platform',
      owner: 't-soft-io',
      repo: 'platform',
      localPath: path,
    });
  });

  it('keeps a bare name pointing at the default owner with no local path', async () => {
    await expect(resolveRepoSource('fiesta', 'kostnerek')).resolves.toEqual({
      dir: 'fiesta',
      owner: 'kostnerek',
      repo: 'fiesta',
      localPath: null,
    });
  });
});

describe('findDuplicateDirs', () => {
  it('spots two repositories that would share a workspace directory', () => {
    const sources: RepoSource[] = [
      { dir: 'platform', owner: 'a', repo: 'platform', localPath: null },
      { dir: 'platform', owner: 'b', repo: 'platform', localPath: null },
      { dir: 'web', owner: 'a', repo: 'web', localPath: null },
    ];
    expect(findDuplicateDirs(sources)).toEqual(['platform']);
  });

  it('is empty when every directory is distinct', () => {
    expect(findDuplicateDirs([{ dir: 'a', owner: 'o', repo: 'a', localPath: null }])).toEqual([]);
  });
});

describe('findGitRepos', () => {
  it('finds repositories nested below the scanned directory', async () => {
    await makeRepo(join(root, 'tsoft', 'platform'));
    await makeRepo(join(root, 'tsoft', 'backoffice'));
    await makeRepo(join(root, 'fiesta'));

    await expect(findGitRepos(root)).resolves.toEqual([
      join(root, 'fiesta'),
      join(root, 'tsoft', 'backoffice'),
      join(root, 'tsoft', 'platform'),
    ]);
  });

  it('does not descend into a repository it already found', async () => {
    const outer = await makeRepo(join(root, 'outer'));
    await makeRepo(join(outer, 'inner'));

    await expect(findGitRepos(root)).resolves.toEqual([outer]);
  });

  it('skips node_modules and dotted directories', async () => {
    await makeRepo(join(root, 'node_modules', 'dep'));
    await makeRepo(join(root, '.cache', 'thing'));
    await makeRepo(join(root, 'real'));

    await expect(findGitRepos(root)).resolves.toEqual([join(root, 'real')]);
  });

  it('returns nothing for a directory that does not exist', async () => {
    await expect(findGitRepos(join(root, 'missing'))).resolves.toEqual([]);
  });
});
