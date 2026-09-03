import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  chooseInstallDir,
  credentialsFile,
  exportHint,
  isOnPath,
  prependToPath,
  findMissingTools,
  hasCredentialsFile,
  REQUIRED_TOOLS,
  survivesUnraidReboot,
  type Tool,
  unsupportedNodeVersion,
} from './tools.js';

function makeTool(name: string, installable: boolean): Tool {
  return {
    name,
    probe: { command: name, args: ['--version'] },
    ...(installable
      ? { install: { command: 'npm', args: ['install', '-g', name], describe: `npm install -g ${name}` } }
      : {}),
    hint: `Install ${name}.`,
  };
}

describe('findMissingTools', () => {
  it('returns only the tools whose probe fails', async () => {
    const run = vi.fn(async (command: string) => {
      if (command === 'herdr') {
        throw new Error('not found');
      }
    });

    const missing = await findMissingTools([makeTool('git', false), makeTool('herdr', true)], run);

    expect(missing.map((tool) => tool.name)).toEqual(['herdr']);
  });

  it('probes docker with info rather than a version flag', () => {
    const docker = REQUIRED_TOOLS.find((tool) => tool.name === 'docker');
    expect(docker?.probe.args).toEqual(['info']);
  });

  it('offers an install only for the tools setup may install', () => {
    const installable = REQUIRED_TOOLS.filter((tool) => tool.install).map((tool) => tool.name);
    expect(installable).toEqual(['claude', 'herdr']);
  });
});

describe('unsupportedNodeVersion', () => {
  it('accepts a supported major', () => {
    expect(unsupportedNodeVersion('22.11.0')).toBeNull();
  });

  it('rejects an older major and names the version it found', () => {
    expect(unsupportedNodeVersion('20.19.0')).toMatch(/Node 20\.19\.0/);
  });

  it('rejects an unparsable version rather than assuming it is fine', () => {
    expect(unsupportedNodeVersion('unknown')).not.toBeNull();
  });
});

describe('hasCredentialsFile', () => {
  it('is false when the directory holds no credentials file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fiesta-tools-'));
    await expect(hasCredentialsFile(directory)).resolves.toBe(false);
  });

  it('is true once the file exists', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fiesta-tools-'));
    await writeFile(credentialsFile(directory), '{}');
    await expect(hasCredentialsFile(directory)).resolves.toBe(true);
  });
});

describe('survivesUnraidReboot', () => {
  it.each([
    ['/mnt/user/appdata/fiesta', true],
    ['/boot/config/fiesta', true],
    ['/root/.local/bin', false],
    ['/usr/local/bin', false],
  ])('%s -> %s', (path, expected) => {
    expect(survivesUnraidReboot(path)).toBe(expected);
  });
});

describe('PATH handling', () => {
  it('reports whether a directory is on PATH', () => {
    expect(isOnPath('/usr/bin:/usr/local/bin', '/usr/local/bin')).toBe(true);
    expect(isOnPath('/usr/bin', '/root/.local/bin')).toBe(false);
    expect(isOnPath(undefined, '/usr/local/bin')).toBe(false);
  });

  it('prepends a directory once and leaves an existing one alone', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    prependToPath(env, '/root/.local/bin');
    prependToPath(env, '/root/.local/bin');
    expect(env.PATH).toBe('/root/.local/bin:/usr/bin');
  });

  it('gives an export line the user can paste', () => {
    expect(exportHint('/root/.local/bin')).toBe('export PATH="/root/.local/bin:$PATH"');
  });

  it('installs into a writable directory that is already on PATH', async () => {
    const writable = await mkdtemp(join(tmpdir(), 'fiesta-bin-'));
    await expect(chooseInstallDir(`/definitely/not/there:${writable}`)).resolves.toBe(writable);
  });

  it('falls back to ~/.local/bin when nothing on PATH is writable', async () => {
    await expect(chooseInstallDir('/definitely/not/there')).resolves.toMatch(/\.local\/bin$/);
  });
});
