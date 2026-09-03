import type { RepoSource } from './repo-source.js';
import type { Ticket } from './ticket.js';

export function buildPrompt(ticket: Ticket, owner: string, sources: RepoSource[]): string {
  const checkouts = sources.map(
    (source) => `  /workspace/${source.dir}  ->  github.com/${source.owner}/${source.repo}`,
  );

  return [
    'Use the orchestrate-ticket skill to deliver this ticket end to end.',
    '',
    `Project: ${ticket.project}`,
    `Base branch: ${ticket.baseBranch}`,
    `Working branch: ${ticket.branch}`,
    '',
    'Repositories, each already cloned and on the working branch:',
    ...checkouts,
    '',
    `Title: ${ticket.title}`,
    '',
    'Description and acceptance criteria:',
    ticket.description,
    '',
    'Pushing and opening pull requests:',
    '- Change only the repositories this ticket actually needs. Leaving one untouched is',
    '  the normal case, not a failure.',
    '- In each repository you changed, `git push -u origin HEAD` works with no extra setup,',
    '  because origin already points at GitHub and git is pre-authenticated.',
    '- Open one draft PR per changed repository. There is no gh CLI in this container, so',
    '  use the GitHub REST API with curl and jq, as described in the orchestrate-ticket skill.',
    '- End your turn listing every PR URL you opened.',
    `- GITHUB_OWNER (${owner}), FIESTA_PROJECT (${ticket.project}), FIESTA_REPOS`,
    `  (${sources.map((source) => `${source.owner}/${source.repo}`).join(',')}) and`,
    `  FIESTA_BASE_BRANCH (${ticket.baseBranch}) are set in your`,
    '  environment, alongside GITHUB_TOKEN.',
  ].join('\n');
}

export function buildAgentCommand(params: {
  workspacePath: string;
  claudeCredentials: string;
  envFilePath: string;
  uid: number;
  gid: number;
}): string {
  return [
    'docker run --rm -i',
    `--user ${params.uid}:${params.gid}`,
    `-v ${params.workspacePath}:/workspace`,
    `-v ${params.claudeCredentials}/.credentials.json:/home/agent/.claude/.credentials.json:ro`,
    `--env-file ${params.envFilePath}`,
    'fiesta-agent:latest',
  ].join(' ');
}
