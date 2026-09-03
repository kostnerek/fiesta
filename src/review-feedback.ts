export type PrComment = {
  id: number;
  author: string;
  body: string;
  path: string | null;
  line: number | null;
};

export function unseenComments(params: {
  comments: PrComment[];
  lastSeenId: number | null;
  agentLogin: string;
}): PrComment[] {
  const { comments, lastSeenId, agentLogin } = params;
  return comments
    .filter((comment) => lastSeenId === null || comment.id > lastSeenId)
    .filter((comment) => comment.author !== agentLogin)
    .filter((comment) => comment.body.trim().length > 0)
    .sort((a, b) => a.id - b.id);
}

export function highestCommentId(comments: PrComment[]): number | null {
  return comments.reduce<number | null>((max, comment) => Math.max(max ?? 0, comment.id), null);
}

export function formatFeedback(params: { prUrl: string; comments: PrComment[] }): string {
  const items = params.comments.map((comment) => {
    const where = comment.path ? ` on ${comment.path}${comment.line ? `:${comment.line}` : ''}` : '';
    return `- ${comment.author}${where}: ${comment.body.trim()}`;
  });

  return [
    `New review feedback on ${params.prUrl}:`,
    '',
    ...items,
    '',
    'Address each point in the repository it refers to, run verify-ticket again, and push to',
    'the same branch — do not open another pull request. If a point is wrong or you disagree,',
    'reply to it on the PR explaining why rather than changing the code.',
    'End your turn with @@FIESTA:DONE and the pull request URL, or @@FIESTA:ASK if you need a',
    'decision only a human can make.',
  ].join('\n');
}
