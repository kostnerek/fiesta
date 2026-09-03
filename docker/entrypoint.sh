#!/usr/bin/env bash
set -euo pipefail

: "${GITHUB_TOKEN:?missing — the agent cannot push or open a PR without it}"
: "${GITHUB_OWNER:?missing — the agent cannot open a PR without it}"
: "${FIESTA_PROMPT_B64:?missing — there is no ticket to work on}"

git config --global user.name "$GITHUB_OWNER"
git config --global user.email "$GITHUB_OWNER@users.noreply.github.com"
git config --global --add safe.directory '*'
git config --global core.hooksPath /usr/local/share/git-hooks

git config --global credential.https://github.com.helper \
  '!f() { echo username=x-access-token; echo "password=$GITHUB_TOKEN"; }; f'

umask 077
printf '//npm.pkg.github.com/:_authToken=%s\n' "$GITHUB_TOKEN" > "$HOME/.npmrc"
umask 022

echo "$FIESTA_PROMPT_B64" | base64 -d > /tmp/prompt.txt

exec claude --dangerously-skip-permissions "$(cat /tmp/prompt.txt)"
