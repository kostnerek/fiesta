import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addRepos,
  parseProjects,
  projectsPath,
  readProjects,
  removeRepos,
  resolveProject,
  writeProjects,
} from './projects.js';
import { TicketError } from './ticket.js';

async function emptyRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'fiesta-projects-'));
}

describe('readProjects', () => {
  it('treats a missing file as no projects rather than an error', async () => {
    await expect(readProjects(await emptyRoot())).resolves.toEqual({});
  });

  it('round-trips through the file', async () => {
    const root = await emptyRoot();
    await writeProjects(root, { tsoft: ['platform', 'backoffice'] });
    await expect(readProjects(root)).resolves.toEqual({ tsoft: ['backoffice', 'platform'] });
  });

  it('rejects a file whose project does not map to a list of names', async () => {
    const root = await emptyRoot();
    await writeFile(projectsPath(root), '{"tsoft": "platform"}');
    await expect(readProjects(root)).rejects.toThrow(/list of repository names/);
  });
});

describe('parseProjects', () => {
  it('rejects a top-level array', () => {
    expect(() => parseProjects('["platform"]')).toThrow(/map each project name/);
  });
});

describe('addRepos', () => {
  it('creates a project that does not exist yet', () => {
    expect(addRepos({}, 'tsoft', ['platform'])).toEqual({ tsoft: ['platform'] });
  });

  it('adds to an existing project without duplicating', () => {
    const projects = addRepos({ tsoft: ['platform'] }, 'tsoft', ['platform', 'backoffice']);
    expect(projects.tsoft).toEqual(['platform', 'backoffice']);
  });

  it('leaves other projects untouched', () => {
    expect(addRepos({ fiesta: ['fiesta'] }, 'tsoft', ['platform']).fiesta).toEqual(['fiesta']);
  });
});

describe('removeRepos', () => {
  it('drops the whole project when no repos are named', () => {
    expect(removeRepos({ tsoft: ['platform'] }, 'tsoft', [])).toEqual({});
  });

  it('drops only the named repos', () => {
    const projects = removeRepos({ tsoft: ['platform', 'backoffice'] }, 'tsoft', ['backoffice']);
    expect(projects.tsoft).toEqual(['platform']);
  });

  it('drops the project once its last repo is removed', () => {
    expect(removeRepos({ tsoft: ['platform'] }, 'tsoft', ['platform'])).toEqual({});
  });

  it('refuses to remove a project that does not exist', () => {
    expect(() => removeRepos({}, 'tsoft', [])).toThrow(/No project named/);
  });
});

describe('resolveProject', () => {
  it('returns the project repositories', () => {
    expect(resolveProject({ tsoft: ['platform', 'backoffice'] }, 'tsoft')).toEqual([
      'platform',
      'backoffice',
    ]);
  });

  it('throws TicketError naming the known projects, so the card lands in Backlog', () => {
    expect(() => resolveProject({ fiesta: ['fiesta'] }, 'typo')).toThrow(TicketError);
    expect(() => resolveProject({ fiesta: ['fiesta'] }, 'typo')).toThrow(/Known projects: fiesta/);
  });

  it('treats a project with no repositories as unknown', () => {
    expect(() => resolveProject({ tsoft: [] }, 'tsoft')).toThrow(TicketError);
  });
});
