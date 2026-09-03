import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TicketError } from './ticket.js';

export type Projects = Record<string, string[]>;

export function projectsPath(root: string): string {
  return join(root, 'projects.json');
}

export function parseProjects(raw: string): Projects {
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('projects.json must map each project name to a list of repositories.');
  }

  const projects: Projects = {};
  for (const [name, repos] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(repos) || repos.some((repo) => typeof repo !== 'string')) {
      throw new Error(`Project "${name}" must map to a list of repository names.`);
    }
    projects[name] = repos as string[];
  }
  return projects;
}

export async function readProjects(root: string): Promise<Projects> {
  try {
    return parseProjects(await readFile(projectsPath(root), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

export async function writeProjects(root: string, projects: Projects): Promise<void> {
  const ordered = Object.fromEntries(
    Object.keys(projects)
      .sort()
      .map((name) => [name, [...(projects[name] ?? [])].sort()]),
  );
  await mkdir(root, { recursive: true });
  await writeFile(projectsPath(root), `${JSON.stringify(ordered, null, 2)}\n`);
}

export function addRepos(projects: Projects, name: string, repos: string[]): Projects {
  return { ...projects, [name]: [...new Set([...(projects[name] ?? []), ...repos])] };
}

export function removeRepos(projects: Projects, name: string, repos: string[]): Projects {
  if (!(name in projects)) {
    throw new Error(`No project named "${name}".`);
  }

  const remaining = { ...projects };
  if (repos.length === 0) {
    delete remaining[name];
    return remaining;
  }

  const kept = (projects[name] ?? []).filter((repo) => !repos.includes(repo));
  if (kept.length === 0) {
    delete remaining[name];
    return remaining;
  }

  remaining[name] = kept;
  return remaining;
}

export function resolveProject(projects: Projects, name: string): string[] {
  const repos = projects[name];
  if (!repos || repos.length === 0) {
    const known = Object.keys(projects).sort().join(', ') || 'none';
    throw new TicketError(
      `No project named "${name}". Known projects: ${known}. Add one with "fiesta project add ${name} <repo...>".`,
    );
  }
  return repos;
}
