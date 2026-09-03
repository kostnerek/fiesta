#!/usr/bin/env bash
set -euo pipefail

git config --global user.name "fiesta-agent"
git config --global user.email "fiesta-agent@localhost"
git config --global --add safe.directory /workspace

echo "$FIESTA_PROMPT_B64" | base64 -d > /tmp/prompt.txt

exec claude --dangerously-skip-permissions "$(cat /tmp/prompt.txt)"
