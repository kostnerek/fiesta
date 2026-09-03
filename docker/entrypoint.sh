#!/usr/bin/env bash
set -euo pipefail

: "${GITHUB_TOKEN:?missing — the agent cannot push or open a PR without it}"
: "${GITHUB_OWNER:?missing — the agent cannot open a PR without it}"
: "${FIESTA_PROMPT_B64:?missing — there is no ticket to work on}"

git config --global user.name "fiesta-agent"
git config --global user.email "fiesta-agent@localhost"
git config --global --add safe.directory /workspace

git config --global credential.https://github.com.helper \
  '!f() { echo username=x-access-token; echo "password=$GITHUB_TOKEN"; }; f'

echo "$FIESTA_PROMPT_B64" | base64 -d > /tmp/prompt.txt

exec claude --dangerously-skip-permissions "$(cat /tmp/prompt.txt)"
