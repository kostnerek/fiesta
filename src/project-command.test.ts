import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runProjectCommand, type ProjectCommandDeps } from './project-command.js';
import { readProjects } from './projects.js';

async function build(overrides: Partial<ProjectCommandDeps> = {}) {
  const lines: string[] = [];
  const deps: ProjectCommandDeps = {
    root: await mkdtemp(join(tmpdir(), 'fiesta-project-cmd-')),
    defaultOwner: 'kostnerek',
    resolveRepoSource: vi.fn(async (entry: string, owner: string) => ({
      dir: entry.split('/').pop() ?? entry,
      owner: entry.includes('/') && !entry.startsWith('/') ? (entry.split('/')[0] as string) : owner,
      repo: entry.split('/').pop() ?? entry,
      localPath: entry.startsWith('/') ? entry : null,
    })),
    findGitRepos: vi.fn().mockResolvedValue([]),
    repoExists: vi.fn().mockResolvedValue(true),
    ensureLabel: vi.fn().mockResolvedValue(true),
    prompts: {
      projectName: vi.fn().mockResolvedValue('tsoft'),
      scanDirectory: vi.fn().mockResolvedValue('/repos'),
      pickRepos: vi.fn().mockResolvedValue([]),
      scanAgain: vi.fn().mockResolvedValue(false),
    },
    log: (line: string) => lines.push(line),
    ...overrides,
  };
  return { deps, lines, output: () => lines.join('\n') };
}

describe('fiesta project add', () => {
  it('stores the repositories and creates the board label', async () => {
    const { deps, output } = await build();

    const code = await runProjectCommand(['add', 'tsoft', 'platform', 'backoffice'], deps);

    expect(code).toBe(0);
    await expect(readProjects(deps.root)).resolves.toEqual({ tsoft: ['backoffice', 'platform'] });
    expect(deps.ensureLabel).toHaveBeenCalledWith('tsoft');
    expect(output()).toMatch(/Created the "tsoft" label/);
  });

  it('says so when the label was already there', async () => {
    const { deps, output } = await build({ ensureLabel: vi.fn().mockResolvedValue(false) });
    await runProjectCommand(['add', 'tsoft', 'platform'], deps);
    expect(output()).toMatch(/already exists/);
  });

  it('changes nothing when a repository does not exist', async () => {
    const { deps, output } = await build({
      repoExists: vi.fn(async (_owner: string, repo: string) => repo !== 'typo'),
    });

    const code = await runProjectCommand(['add', 'tsoft', 'platform', 'typo'], deps);

    expect(code).toBe(1);
    expect(output()).toMatch(/No such repository on GitHub: kostnerek\/typo/);
    await expect(readProjects(deps.root)).resolves.toEqual({});
    expect(deps.ensureLabel).not.toHaveBeenCalled();
  });

  it('adds to an existing project rather than replacing it', async () => {
    const { deps } = await build();
    await runProjectCommand(['add', 'tsoft', 'platform'], deps);
    await runProjectCommand(['add', 'tsoft', 'backoffice'], deps);
    await expect(readProjects(deps.root)).resolves.toEqual({ tsoft: ['backoffice', 'platform'] });
  });

  it('falls back to the wizard when add names no repositories', async () => {
    const { deps } = await build();
    expect(await runProjectCommand(['add', 'tsoft'], deps)).toBe(1);
    expect(deps.prompts.projectName).toHaveBeenCalled();
  });
});

describe('fiesta project remove', () => {
  it('drops named repositories and keeps the rest', async () => {
    const { deps } = await build();
    await runProjectCommand(['add', 'tsoft', 'platform', 'backoffice'], deps);

    await runProjectCommand(['remove', 'tsoft', 'backoffice'], deps);

    await expect(readProjects(deps.root)).resolves.toEqual({ tsoft: ['platform'] });
  });

  it('drops the whole project when no repositories are named', async () => {
    const { deps } = await build();
    await runProjectCommand(['add', 'tsoft', 'platform'], deps);
    await runProjectCommand(['remove', 'tsoft'], deps);
    await expect(readProjects(deps.root)).resolves.toEqual({});
  });

  it('reports an unknown project instead of throwing', async () => {
    const { deps, output } = await build();
    expect(await runProjectCommand(['remove', 'nope'], deps)).toBe(1);
    expect(output()).toMatch(/No project named "nope"/);
  });
});

describe('fiesta project list', () => {
  it('guides the user when nothing is configured', async () => {
    const { deps, output } = await build();
    expect(await runProjectCommand(['list'], deps)).toBe(0);
    expect(output()).toMatch(/No projects yet/);
  });

  it('lists each project with its repositories', async () => {
    const { deps, output } = await build();
    await runProjectCommand(['add', 'tsoft', 'platform', 'backoffice'], deps);
    await runProjectCommand(['list'], deps);
    expect(output()).toMatch(/tsoft: backoffice, platform/);
  });
});

describe('fiesta project (no subcommand)', () => {
  it('prints usage and fails on an unknown subcommand', async () => {
    const { deps, output } = await build();
    expect(await runProjectCommand(['wat'], deps)).toBe(1);
    expect(output()).toMatch(/fiesta project add/);
  });
});

describe('fiesta project (interactive)', () => {
  it('asks for a name, scans, and saves what was ticked', async () => {
    const { deps, output } = await build({
      findGitRepos: vi.fn().mockResolvedValue(['/repos/tsoft/platform', '/repos/tsoft/web']),
      prompts: {
        projectName: vi.fn().mockResolvedValue('tsoft'),
        scanDirectory: vi.fn().mockResolvedValue('/repos'),
        pickRepos: vi.fn().mockResolvedValue(['/repos/tsoft/platform']),
        scanAgain: vi.fn().mockResolvedValue(false),
      },
    });

    expect(await runProjectCommand([], deps)).toBe(0);
    await expect(readProjects(deps.root)).resolves.toEqual({ tsoft: ['/repos/tsoft/platform'] });
    expect(deps.ensureLabel).toHaveBeenCalledWith('tsoft');
    expect(output()).toMatch(/\(local\)/);
  });

  it('accumulates picks across several directories', async () => {
    const scanAgain = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    const { deps } = await build({
      findGitRepos: vi
        .fn()
        .mockResolvedValueOnce(['/a/platform'])
        .mockResolvedValueOnce(['/b/web']),
      prompts: {
        projectName: vi.fn().mockResolvedValue('tsoft'),
        scanDirectory: vi.fn().mockResolvedValueOnce('/a').mockResolvedValue('/b'),
        pickRepos: vi.fn(async (found: { path: string }[]) => found.map((entry) => entry.path)),
        scanAgain,
      },
    });

    expect(await runProjectCommand([], deps)).toBe(0);
    await expect(readProjects(deps.root)).resolves.toEqual({ tsoft: ['/a/platform', '/b/web'] });
  });

  it('saves nothing when the user ticks nothing', async () => {
    const { deps, output } = await build({
      findGitRepos: vi.fn().mockResolvedValue(['/repos/platform']),
    });

    expect(await runProjectCommand([], deps)).toBe(1);
    expect(output()).toMatch(/Nothing selected/);
    await expect(readProjects(deps.root)).resolves.toEqual({});
  });

  it('refuses two repositories that would share one workspace directory', async () => {
    const { deps, output } = await build({
      findGitRepos: vi.fn().mockResolvedValue(['/a/platform', '/b/platform']),
      prompts: {
        projectName: vi.fn().mockResolvedValue('tsoft'),
        scanDirectory: vi.fn().mockResolvedValue('/'),
        pickRepos: vi.fn().mockResolvedValue(['/a/platform', '/b/platform']),
        scanAgain: vi.fn().mockResolvedValue(false),
      },
    });

    expect(await runProjectCommand([], deps)).toBe(1);
    expect(output()).toMatch(/would both be checked out as "platform"/);
    await expect(readProjects(deps.root)).resolves.toEqual({});
  });

  it('rejects an empty project name', async () => {
    const { deps, output } = await build({
      prompts: {
        projectName: vi.fn().mockResolvedValue('   '),
        scanDirectory: vi.fn(),
        pickRepos: vi.fn(),
        scanAgain: vi.fn(),
      },
    });

    expect(await runProjectCommand([], deps)).toBe(1);
    expect(output()).toMatch(/needs a name/);
  });
});
