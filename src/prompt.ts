import type { Ticket } from './ticket.js';

export function buildPrompt(ticket: Ticket, owner: string): string {
  return [
    'Use the orchestrate-ticket skill to deliver this ticket end to end.',
    '',
    `Repository: ${ticket.repo}`,
    `Base branch: ${ticket.baseBranch}`,
    `Working branch: ${ticket.branch} (already checked out in /workspace)`,
    '',
    `Title: ${ticket.title}`,
    '',
    'Description and acceptance criteria:',
    ticket.description,
    '',
    'Pushing and opening the PR:',
    `- origin already points at https://github.com/${owner}/${ticket.repo}.git and git is`,
    '  pre-authenticated for it, so `git push -u origin HEAD` works with no extra setup.',
    '- There is no gh CLI in this container. Open the draft PR with the GitHub REST API',
    '  using curl and jq, as described in the orchestrate-ticket skill.',
    `- GITHUB_OWNER (${owner}), FIESTA_REPO (${ticket.repo}) and FIESTA_BASE_BRANCH`,
    `  (${ticket.baseBranch}) are set in your environment, alongside GITHUB_TOKEN.`,
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
