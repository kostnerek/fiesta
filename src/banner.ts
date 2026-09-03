import type { Config } from './config.js';

const ART = [
  '  __ _           _        ',
  ' / _(_) ___  ___| |_ __ _ ',
  '| |_| |/ _ \\/ __| __/ _` |',
  '|  _| |  __/\\__ \\ || (_| |',
  '|_| |_|\\___||___/\\__\\__,_|',
];

export function banner(): string[] {
  return [...ART];
}

export function startupLines(params: {
  config: Config;
  projects: string[];
  version: string;
}): string[] {
  const { config, projects, version } = params;
  const seconds = Math.round(config.limits.pollIntervalMs / 1000);
  const tickets = config.limits.maxActive === 1 ? '1 ticket' : `${config.limits.maxActive} tickets`;

  return [
    version ? `fiesta ${version}` : 'fiesta',
    `board      ${config.trello.boardId}`,
    projects.length > 0
      ? `projects   ${projects.join(', ')}`
      : 'projects   none yet — add one with "fiesta project"',
    `data root  ${config.paths.root}`,
    `polling    Ready every ${seconds}s, ${tickets} at a time`,
    '',
    'Drop a card in Ready to start. Ctrl-C to stop.',
  ];
}
