import { addRepos, readProjects, removeRepos, writeProjects } from './projects.js';
import { findDuplicateDirs, type RepoSource, type resolveRepoSource } from './repo-source.js';

export const PROJECT_USAGE = `Usage:
  fiesta project                       Add a project interactively
  fiesta project list
  fiesta project add <project> <entry...>
  fiesta project remove <project> [entry...]

An entry is a path to a clone already on this machine (/mnt/user/repos/platform),
or a GitHub reference (owner/repo, or just repo for your own account). A path is
preferred: fiesta copies from it instead of downloading the repository again.

A card carries exactly one label, and that label names a project. Every repository
of the project is checked out together, so one card can change several of them.`;

export type ProjectPrompts = {
  projectName: () => Promise<string>;
  scanDirectory: () => Promise<string>;
  pickRepos: (found: { path: string; label: string }[]) => Promise<string[]>;
  scanAgain: () => Promise<boolean>;
};

export type ProjectCommandDeps = {
  root: string;
  defaultOwner: string;
  resolveRepoSource: typeof resolveRepoSource;
  findGitRepos: (directory: string) => Promise<string[]>;
  repoExists: (owner: string, repo: string) => Promise<boolean>;
  ensureLabel: (name: string) => Promise<boolean>;
  prompts: ProjectPrompts;
  log: (line: string) => void;
};

async function describe(
  entry: string,
  deps: ProjectCommandDeps,
): Promise<{ source: RepoSource } | { error: string }> {
  try {
    return { source: await deps.resolveRepoSource(entry, deps.defaultOwner) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function validate(
  entries: string[],
  deps: ProjectCommandDeps,
): Promise<{ sources: RepoSource[] } | { problems: string[] }> {
  const problems: string[] = [];
  const sources: RepoSource[] = [];

  for (const entry of entries) {
    const described = await describe(entry, deps);
    if ('error' in described) {
      problems.push(described.error);
      continue;
    }
    if (!described.source.localPath && !(await deps.repoExists(described.source.owner, described.source.repo))) {
      problems.push(`No such repository on GitHub: ${described.source.owner}/${described.source.repo}.`);
      continue;
    }
    sources.push(described.source);
  }

  for (const duplicate of findDuplicateDirs(sources)) {
    problems.push(
      `Two repositories would both be checked out as "${duplicate}"; a project cannot contain both.`,
    );
  }

  return problems.length > 0 ? { problems } : { sources };
}

async function save(
  name: string,
  entries: string[],
  sources: RepoSource[],
  deps: ProjectCommandDeps,
): Promise<void> {
  await writeProjects(deps.root, addRepos(await readProjects(deps.root), name, entries));
  const created = await deps.ensureLabel(name);

  deps.log(`\nProject "${name}":`);
  for (const source of sources) {
    deps.log(`  ${source.dir}  ->  ${source.owner}/${source.repo}${source.localPath ? '  (local)' : ''}`);
  }
  deps.log(
    created ? `Created the "${name}" label on the board.` : `The "${name}" label already exists.`,
  );
}

async function addInteractively(deps: ProjectCommandDeps): Promise<number> {
  const name = (await deps.prompts.projectName()).trim();
  if (!name) {
    deps.log('A project needs a name.');
    return 1;
  }

  const chosen: string[] = [];
  for (;;) {
    const directory = (await deps.prompts.scanDirectory()).trim();
    const found = (await deps.findGitRepos(directory)).filter((path) => !chosen.includes(path));

    if (found.length === 0) {
      deps.log(`No git repositories under ${directory} that are not already selected.`);
    } else {
      const labelled = [];
      for (const path of found) {
        const described = await describe(path, deps);
        labelled.push({
          path,
          label: 'error' in described ? `${path}  (no origin — cannot push)` : `${path}  ->  ${described.source.owner}/${described.source.repo}`,
        });
      }
      chosen.push(...(await deps.prompts.pickRepos(labelled)));
    }

    if (!(await deps.prompts.scanAgain())) {
      break;
    }
  }

  if (chosen.length === 0) {
    deps.log('Nothing selected, so nothing was saved.');
    return 1;
  }

  const validated = await validate(chosen, deps);
  if ('problems' in validated) {
    validated.problems.forEach((problem) => deps.log(problem));
    deps.log('Nothing was saved.');
    return 1;
  }

  await save(name, chosen, validated.sources, deps);
  return 0;
}

export async function runProjectCommand(args: string[], deps: ProjectCommandDeps): Promise<number> {
  const [subcommand, name, ...entries] = args;

  if (subcommand === undefined) {
    return addInteractively(deps);
  }

  if (subcommand === 'list') {
    const projects = await readProjects(deps.root);
    const names = Object.keys(projects).sort();
    if (names.length === 0) {
      deps.log('No projects yet. Run "fiesta project" to add one.');
      return 0;
    }
    for (const project of names) {
      deps.log(`${project}: ${(projects[project] ?? []).join(', ')}`);
    }
    return 0;
  }

  if (subcommand === 'add') {
    if (!name) {
      deps.log(PROJECT_USAGE);
      return 1;
    }
    if (entries.length === 0) {
      return addInteractively(deps);
    }

    const validated = await validate(entries, deps);
    if ('problems' in validated) {
      validated.problems.forEach((problem) => deps.log(problem));
      deps.log('Nothing was changed.');
      return 1;
    }

    await save(name, entries, validated.sources, deps);
    return 0;
  }

  if (subcommand === 'remove') {
    if (!name) {
      deps.log(PROJECT_USAGE);
      return 1;
    }
    try {
      await writeProjects(deps.root, removeRepos(await readProjects(deps.root), name, entries));
    } catch (error) {
      deps.log(error instanceof Error ? error.message : String(error));
      return 1;
    }
    deps.log(
      entries.length === 0
        ? `Removed project "${name}".`
        : `Removed ${entries.join(', ')} from "${name}".`,
    );
    deps.log('The board label was left in place; delete it in Trello if you no longer want it.');
    return 0;
  }

  deps.log(PROJECT_USAGE);
  return 1;
}
