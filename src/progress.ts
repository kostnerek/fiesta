export const STAGES = ['claimed', 'building', 'testing', 'qa', 'review', 'merged'] as const;

export type Stage = (typeof STAGES)[number];

const LABELS: Record<Stage, string> = {
  claimed: 'wzięty',
  building: 'piszę kod',
  testing: 'testy',
  qa: 'QA na żywym stacku',
  review: 'PR wystawiony',
  merged: 'zmergowany',
};

export function isStage(value: string): value is Stage {
  return (STAGES as readonly string[]).includes(value);
}

export function nextStage(current: Stage, candidate: string): Stage {
  if (!isStage(candidate)) {
    return current;
  }
  return STAGES.indexOf(candidate) > STAGES.indexOf(current) ? candidate : current;
}

export function formatProgress(params: {
  shortLink: string;
  title: string;
  stage: Stage;
  blocked?: string;
}): string {
  const header = `[${params.shortLink}] ${params.title}`;
  if (params.blocked) {
    return `${header}\n\n⛔ zatrzymany na etapie "${LABELS[params.stage]}"\n${params.blocked}`;
  }

  const reached = STAGES.indexOf(params.stage) + 1;
  const bar = '█'.repeat(reached) + '░'.repeat(STAGES.length - reached);
  return `${header}\n\n${bar} ${reached}/${STAGES.length}  ${LABELS[params.stage]}`;
}
