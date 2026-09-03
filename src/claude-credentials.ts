import { readFile } from 'node:fs/promises';

export const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export type CredentialState =
  | { usable: true }
  | { usable: false; reason: string };

type Stored = {
  claudeAiOauth?: {
    expiresAt?: number;
    refreshToken?: string;
    refreshTokenExpiresAt?: number;
  };
};

export function assessCredentials(raw: string, now: number): CredentialState {
  let parsed: Stored;
  try {
    parsed = JSON.parse(raw) as Stored;
  } catch {
    return { usable: false, reason: 'the credentials file is not valid JSON' };
  }

  const oauth = parsed.claudeAiOauth;
  if (!oauth) {
    return { usable: false, reason: 'the credentials file has no claudeAiOauth section' };
  }

  const { expiresAt, refreshToken, refreshTokenExpiresAt } = oauth;

  if (typeof expiresAt === 'number' && expiresAt - REFRESH_MARGIN_MS > now) {
    return { usable: true };
  }

  if (!refreshToken) {
    return { usable: false, reason: 'the access token has expired and there is no refresh token' };
  }

  if (typeof refreshTokenExpiresAt === 'number' && refreshTokenExpiresAt <= now) {
    return { usable: false, reason: 'both the access token and the refresh token have expired' };
  }

  return { usable: true };
}

export async function checkCredentials(path: string, now: number): Promise<CredentialState> {
  try {
    return assessCredentials(await readFile(path, 'utf8'), now);
  } catch {
    return { usable: false, reason: `no credentials file at ${path}` };
  }
}
