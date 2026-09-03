#!/usr/bin/env node
import { join } from 'node:path';

const USAGE = `fiesta — autonomous coding agents driven by a Trello board

Usage:
  fiesta setup    Collect and verify credentials, seed the board, write .env
  fiesta start    Run the daemon

Run setup once on the server, then start.`;

function loadEnvFile(): void {
  try {
    process.loadEnvFile(join(process.cwd(), '.env'));
  } catch {
    return;
  }
}

const command = process.argv[2];

if (command === 'setup') {
  loadEnvFile();
  await import('./setup.js');
} else if (command === 'start') {
  loadEnvFile();
  await import('./main.js');
} else {
  const askedForHelp = command === undefined || command === '--help' || command === '-h';
  console.log(askedForHelp ? USAGE : `Unknown command: ${command}\n\n${USAGE}`);
  process.exit(askedForHelp ? 0 : 1);
}
