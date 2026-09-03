import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const HOOK = join(process.cwd(), 'docker/githooks/commit-msg');

async function strip(message: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fiesta-hook-'));
  const path = join(dir, 'COMMIT_EDITMSG');
  await writeFile(path, message);
  await run(HOOK, [path]);
  return readFile(path, 'utf8');
}

describe('commit-msg hook', () => {
  it('removes a Claude co-author trailer whatever its casing', async () => {
    const result = await strip(
      'feat: thing\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>\n',
    );
    expect(result).not.toMatch(/claude/i);
    expect(result).toContain('feat: thing');
  });

  it('removes a generated-with line', async () => {
    const result = await strip('fix: thing\n\n🤖 Generated with Claude Code\n');
    expect(result).not.toMatch(/generated with/i);
  });

  it('keeps a human co-author', async () => {
    const result = await strip(
      'feat: thing\n\nCo-authored-by: Ola <ola@example.com>\nCo-authored-by: Claude <noreply@anthropic.com>\n',
    );
    expect(result).toContain('Co-authored-by: Ola <ola@example.com>');
    expect(result).not.toMatch(/claude/i);
  });

  it('leaves an ordinary message untouched apart from trailing blanks', async () => {
    expect(await strip('feat: thing\n\nA body.\n')).toBe('feat: thing\n\nA body.\n');
  });

  it('does not leave the blank line the trailer sat on', async () => {
    const result = await strip('feat: thing\n\nCo-Authored-By: Claude <x@anthropic.com>\n\n\n');
    expect(result).toBe('feat: thing\n');
  });
});
