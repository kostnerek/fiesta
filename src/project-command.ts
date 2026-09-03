import { addRepos, readProjects, removeRepos, writeProjects } from './projects.js';

export const PROJECT_USAGE = `Usage:
  fiesta project list
  fiesta project add <project> <repo...>
  fiesta project remove <project> [repo...]

A card carries exactly one label, and that label names a project. The project's
repositories are all checked out together, so one card can change several of them.
"remove" without repositories drops the whole project.`;

export type ProjectCommandDeps = {
  root: string;
  repoExists: (repo: string) => Promise<boolean>;
  ensureLabel: (name: string) => Promise<boolean>;
  log: (line: string) => void;
};

export async function runProjectCommand(args: string[], deps: ProjectCommandDeps): Promise<number> {
  const [subcommand, name, ...repos] = args;

  if (subcommand === 'list') {
    const projects = await readProjects(deps.root);
    const names = Object.keys(projects).sort();
    if (names.length === 0) {
      deps.log('No projects yet. Add one with "fiesta project add <project> <repo...>".');
      return 0;
    }
    for (const project of names) {
      deps.log(`${project}: ${(projects[project] ?? []).join(', ')}`);
    }
    return 0;
  }

  if (subcommand === 'add') {
    if (!name || repos.length === 0) {
      deps.log(PROJECT_USAGE);
      return 1;
    }

    const missing: string[] = [];
    for (const repo of repos) {
      if (!(await deps.repoExists(repo))) {
        missing.push(repo);
      }
    }
    if (missing.length > 0) {
      deps.log(`No such repository: ${missing.join(', ')}. Nothing was changed.`);
      return 1;
    }

    await writeProjects(deps.root, addRepos(await readProjects(deps.root), name, repos));
    const created = await deps.ensureLabel(name);
    deps.log(`Project "${name}" now covers: ${repos.join(', ')}.`);
    deps.log(
      created
        ? `Created the "${name}" label on the board.`
        : `The "${name}" label already exists on the board.`,
    );
    return 0;
  }

  if (subcommand === 'remove') {
    if (!name) {
      deps.log(PROJECT_USAGE);
      return 1;
    }
    try {
      await writeProjects(deps.root, removeRepos(await readProjects(deps.root), name, repos));
    } catch (error) {
      deps.log(error instanceof Error ? error.message : String(error));
      return 1;
    }
    deps.log(
      repos.length === 0 ? `Removed project "${name}".` : `Removed ${repos.join(', ')} from "${name}".`,
    );
    deps.log('The board label was left in place; delete it in Trello if you no longer want it.');
    return 0;
  }

  deps.log(PROJECT_USAGE);
  return subcommand === undefined ? 0 : 1;
}
