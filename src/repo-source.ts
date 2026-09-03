import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const MAX_SCAN_DEPTH = 3;

const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'build', 'vendor', 'target']);

export type RepoSource = {
  dir: string;
  owner: string;
  repo: string;
  localPath: string | null;
};

export function isPathEntry(entry: string): boolean {
  return isAbsolute(entry) || entry.startsWith('./') || entry.startsWith('../') || entry.startsWith('~');
}

export function parseOriginUrl(url: string): { owner: string; repo: string } {
  const trimmed = url.trim().replace(/\.git$/, '');
  const ssh = /^git@[^:]+:([^/]+)\/(.+)$/.exec(trimmed);
  if (ssh) {
    return { owner: ssh[1]!, repo: basename(ssh[2]!) };
  }

  const https = /^https?:\/\/[^/]+\/([^/]+)\/(.+)$/.exec(trimmed);
  if (https) {
    return { owner: https[1]!, repo: basename(https[2]!) };
  }

  throw new Error(`Cannot read an owner and repository out of the remote "${url}".`);
}

export function parseGitHubRef(entry: string, defaultOwner: string): { owner: string; repo: string } {
  const parts = entry.split('/').filter((part) => part.length > 0);
  if (parts.length === 1) {
    return { owner: defaultOwner, repo: parts[0]! };
  }
  if (parts.length === 2) {
    return { owner: parts[0]!, repo: parts[1]! };
  }
  throw new Error(`"${entry}" is not a repository name, "owner/repo", or an absolute path.`);
}

export async function readOrigin(repoPath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repoPath, 'remote', 'get-url', 'origin']);
    return stdout.trim();
  } catch {
    throw new Error(`${repoPath} has no "origin" remote, so an agent could not push from it.`);
  }
}

export async function resolveRepoSource(entry: string, defaultOwner: string): Promise<RepoSource> {
  if (!isPathEntry(entry)) {
    const { owner, repo } = parseGitHubRef(entry, defaultOwner);
    return { dir: repo, owner, repo, localPath: null };
  }

  const { owner, repo } = parseOriginUrl(await readOrigin(entry));
  return { dir: repo, owner, repo, localPath: entry };
}

export function findDuplicateDirs(sources: RepoSource[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const source of sources) {
    if (seen.has(source.dir)) {
      duplicates.add(source.dir);
    }
    seen.add(source.dir);
  }
  return [...duplicates];
}

async function isGitRepo(path: string): Promise<boolean> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.some((entry) => entry.name === '.git');
  } catch {
    return false;
  }
}

export async function findGitRepos(root: string, maxDepth = MAX_SCAN_DEPTH): Promise<string[]> {
  if (maxDepth < 0) {
    return [];
  }

  if (await isGitRepo(root)) {
    return [root];
  }

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const found: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || SKIPPED_DIRECTORIES.has(entry.name)) {
      continue;
    }
    found.push(...(await findGitRepos(join(root, entry.name), maxDepth - 1)));
  }
  return found.sort();
}
