import type { PrComment } from './review-feedback.js';

export type PullRequest = { number: number; url: string; merged: boolean };

type RawComment = {
  id: number;
  body?: string;
  user?: { login?: string };
  path?: string;
  line?: number | null;
};

type Credentials = { token: string; owner: string };

type PullRequestPayload = {
  number: number;
  html_url: string;
  merged?: boolean;
  merged_at?: string | null;
};

export class GitHubClient {
  constructor(
    private readonly credentials: Credentials,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchImpl(`https://api.github.com${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.credentials.token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        ...init.headers,
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub ${init.method ?? 'GET'} ${path} failed: ${response.status} ${await response.text()}`);
    }
    return (await response.json()) as T;
  }

  async repoExists(owner: string, repo: string): Promise<boolean> {
    const response = await this.fetchImpl(
      `https://api.github.com/repos/${owner}/${repo}`,
      {
        headers: {
          authorization: `Bearer ${this.credentials.token}`,
          accept: 'application/vnd.github+json',
        },
      },
    );
    if (response.status === 404) {
      return false;
    }
    if (!response.ok) {
      throw new Error(`GitHub GET /repos/${owner}/${repo} failed: ${response.status}`);
    }
    return true;
  }

  async listPrComments(owner: string, repo: string, pull: number): Promise<PrComment[]> {
    const [general, inline] = await Promise.all([
      this.request<RawComment[]>(`/repos/${owner}/${repo}/issues/${pull}/comments?per_page=100`),
      this.request<RawComment[]>(`/repos/${owner}/${repo}/pulls/${pull}/comments?per_page=100`),
    ]);

    return [...general, ...inline].map((raw) => ({
      id: raw.id,
      author: raw.user?.login ?? 'unknown',
      body: raw.body ?? '',
      path: raw.path ?? null,
      line: raw.line ?? null,
    }));
  }

  user(): Promise<{ login: string }> {
    return this.request('/user');
  }

  async tokenScopes(): Promise<string[]> {
    const response = await this.fetchImpl('https://api.github.com/user', {
      headers: {
        authorization: `Bearer ${this.credentials.token}`,
        accept: 'application/vnd.github+json',
      },
    });
    const header = response.headers.get('x-oauth-scopes') ?? '';
    return header
      .split(',')
      .map((scope) => scope.trim())
      .filter((scope) => scope.length > 0);
  }

  async findPrByBranch(owner: string, repo: string, branch: string): Promise<PullRequest | null> {
    const query = new URLSearchParams({
      head: `${owner}:${branch}`,
      state: 'all',
    });
    const payloads = await this.request<PullRequestPayload[]>(
      `/repos/${owner}/${repo}/pulls?${query.toString()}`,
    );
    const payload = payloads[0];
    return payload ? toPullRequest(payload) : null;
  }
}

function toPullRequest(payload: PullRequestPayload): PullRequest {
  return {
    number: payload.number,
    url: payload.html_url,
    merged: payload.merged === true || Boolean(payload.merged_at),
  };
}
