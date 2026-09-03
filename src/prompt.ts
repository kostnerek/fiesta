import type { Ticket } from './ticket.js';

export function buildPrompt(ticket: Ticket, owner: string, repos: string[]): string {
  const checkouts = repos.map((repo) => `  /workspace/${repo}  ->  github.com/${owner}/${repo}`);

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
    `  (${repos.join(',')}) and FIESTA_BASE_BRANCH (${ticket.baseBranch}) are set in your`,
    '  environment, alongside GITHUB_TOKEN.',
  ].join('\n');
}

export function buildAgentCommand(params: {
  workspacePath: string;
  claudeCredentials: string;
  envFilePath: string;
  prompt: string;
}): string {
  const encodedPrompt = Buffer.from(params.prompt, 'utf8').toString('base64');
  return [
    'docker run --rm -i',
    `-v ${params.workspacePath}:/workspace`,
    `-v ${params.claudeCredentials}/.credentials.json:/home/agent/.claude/.credentials.json:ro`,
    `--env-file ${params.envFilePath}`,
    `-e FIESTA_PROMPT_B64=${encodedPrompt}`,
    'fiesta-agent:latest',
  ].join(' ');
}
