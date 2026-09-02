import type { Ticket } from './ticket.js';

export function buildPrompt(ticket: Ticket): string {
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
  ].join('\n');
}

export function buildAgentCommand(params: {
  workspacePath: string;
  claudeCredentials: string;
  githubToken: string;
  prompt: string;
}): string {
  const encodedPrompt = Buffer.from(params.prompt, 'utf8').toString('base64');
  return [
    'docker run --rm -i',
    `-v ${params.workspacePath}:/workspace`,
    `-v ${params.claudeCredentials}/.credentials.json:/home/agent/.claude/.credentials.json:ro`,
    `-e GITHUB_TOKEN=${params.githubToken}`,
    `-e FIESTA_PROMPT_B64=${encodedPrompt}`,
    'fiesta-agent:latest',
  ].join(' ');
}
