# Fiesta

Fiesta is a daemon that watches a Trello board and runs an autonomous coding
agent (Claude Code, in a container) per card. It moves cards through
`Backlog → Ready → In Progress → Review → Done`, and pings Telegram when an
agent needs a human decision.

## Prerequisites

All of the following live on the **same host**, side by side — see "Run the
daemon" below for why.

- **Node 22** and **pnpm** (`pnpm@10.29.2`, pinned in `package.json`).
- **Docker** (daemon + CLI) on the host `PATH`. The daemon itself never
  touches Docker directly — it builds a `docker run ...` command string
  (`buildAgentCommand` in `src/prompt.ts`) and hands it to `herdr`, which
  executes it inside a pane on the host. So `docker` needs to be reachable
  wherever `herdr`'s panes run, i.e. the host.
- **git** — the daemon clones/mirrors repositories and prepares working
  branches on the host filesystem before handing them to an agent container.
- **A running `herdr` server, and the `herdr` CLI, on the same host as the
  daemon.** This is the single most common way to break Fiesta: every
  `herdr` command (workspace create, pane run, pane read, pane send-text,
  ...) fails with `server_not_running` unless a `herdr` server is already
  up. Start/attach a herdr server **before** running `fiesta setup` or
  starting the daemon, and keep it running for the daemon's entire
  lifetime. The daemon (`src/herdr.ts`) shells out to a `herdr` binary in
  `PATH`, so it needs to be on the same `PATH` as the process running
  `fiesta start`.

## Setup

On the server, one command — nothing to clone or install first:

```bash
npx github:kostnerek/fiesta setup
```

Working on the repo locally instead? `pnpm install && pnpm setup` does the
same thing.

`fiesta setup` is an interactive, idempotent wizard. It:

- verifies Node 22+, that `git` is present, and that the Docker **daemon
  answers** (`docker info`) rather than merely that the binary exists;
- offers to install what it safely can — Claude Code
  (`npm install -g @anthropic-ai/claude-code`) and herdr
  (`curl -fsSL https://herdr.dev/install.sh | sh`) — showing the exact
  command and asking first. It will not touch Docker or git: those are
  system-level, and on Unraid Docker is built in;
- **checks that Claude is actually signed in and not expired**, by reading
  the token expiry out of `<credentials dir>/.credentials.json`. Agents authenticate with
  that file; without it every ticket fails, and Docker would silently mount
  an empty directory in its place rather than complaining;
- walks you through Trello (API key + token), creates any missing board
  columns (`Backlog`, `Ready`, `In Progress`, `Blocked`, `Review`, `Done`);
- **verifies each credential as you enter it, and asks again if it is
  rejected** (three attempts), showing the API's own message — a wrong token
  costs you one prompt, not the whole run;
- walks you through Telegram (bot token, auto-detects your chat id) and
  GitHub (token, scope `repo`);
- asks for the data root (defaults to `/mnt/user/appdata/fiesta`) and your
  Claude credentials directory (defaults to `~/.claude`);
- writes all of this to `.env` in the project root, `chmod 600`.

`.env` holds live credentials. It is git-ignored and must **never** be baked
into a container image.

## Build the agent image

Every card is worked by a fresh, throwaway container built from
`docker/agent.Dockerfile`. It's built from the repo root (it copies in
`skills/`, which lives there, not under `docker/`). Build it once (and
rebuild whenever it or `skills/` changes):

```bash
docker build -t fiesta-agent:latest -f docker/agent.Dockerfile .
```

This image contains `git`, `curl`, `jq` and the `claude` CLI, plus an
`entrypoint.sh` that configures git identity and a credential helper,
decodes the base64-encoded prompt from `FIESTA_PROMPT_B64`, and launches
`claude --dangerously-skip-permissions <prompt>`, and the `orchestrate-ticket`
/ `verify-ticket` skills (from `skills/`) copied to
`/home/agent/.claude/skills`. The daemon mounts your Claude credentials
**file** (not the whole directory) read-only into it at
`/home/agent/.claude/.credentials.json`; `/home/agent/.claude` itself stays a
real, writable directory owned by the `agent` user inside the image so that
mount only overlays the one file.

**How the agent pushes.** Every per-ticket checkout has its `origin` repointed
at `https://github.com/<GITHUB_OWNER>/<repo>.git` (the local mirror it was
cloned from is a host path the container cannot see). `GITHUB_TOKEN`,
`GITHUB_OWNER`, `FIESTA_PROJECT`, `FIESTA_REPOS`, `FIESTA_BASE_BRANCH` and the
base64-encoded prompt (`FIESTA_PROMPT_B64`) all reach the container
through `docker run --env-file <root>/env/<shortLink>.env` — a `600` file
written per ticket and deleted with the workspace — rather than
`-e NAME=value`, which would put the token in `ps aux` and in herdr's pane
scrollback for the container's lifetime — and which, for a prompt the length
of a ticket, produced a command line too long to survive being typed into a
pane at all. The entrypoint turns
`GITHUB_TOKEN` into a git credential helper, so `git push` needs no further
setup. There is no `gh` CLI in the image: the agent opens the draft PR
itself with a `curl`/`jq` REST call, as spelled out in
`skills/orchestrate-ticket/SKILL.md`.

## Run the daemon

```bash
fiesta start
```

Fiesta runs directly on the host, next to `herdr` — there is no
`docker-compose.yml` or daemon container image. This is deliberate, not an
omission: the daemon never calls Docker itself. It builds a `docker run`
command string and hands it to `herdr.startAgent`, which runs it as
`herdr pane run <paneId> <command>` inside a pane that belongs to the
**host-level** herdr server. Since the daemon's only path to launching an
agent container runs through herdr's own panes, the daemon has to live
wherever those panes live — the host. A containerised daemon would need its
own `herdr` binary, a mount of herdr's socket (not achievable with
`network_mode: host`, which only shares the network namespace, not unix
sockets), and a docker-socket mount that nothing in the code path actually
reads — three problems in service of an isolation boundary the design
doesn't need. The isolation boundary that matters is the **agent**
container (`docker/agent.Dockerfile`), which every ticket runs inside,
unchanged by any of this.

**Surviving a reboot.** Unraid keeps its OS in RAM, so neither `herdr` nor
`fiesta start` will still be running after a restart unless something
restarts them. Wiring that up — a user script, a system service, or
whatever mechanism you already use for other long-running processes on the
box — is on the operator; this repo doesn't prescribe one. Whatever you
pick, make sure it starts `herdr` before it starts the Fiesta daemon.

If a containerised daemon is wanted later, the compose file and root
Dockerfile from an earlier iteration of this doc are one `git revert` away
in this branch's history — but they'd need herdr's socket and CLI solved
first, not just resurrected as-is.

## Projects

A card carries **exactly one label**, and that label names a **project** — not
a repository. A project is one or more repositories, checked out together, so a
single card can change several of them:

```bash
fiesta project                             # interactive: name it, then tick repositories
fiesta project list
fiesta project add tsoft /mnt/user/repos/platform /mnt/user/repos/backoffice
fiesta project remove tsoft backoffice     # or omit entries to drop the project
```

Run `fiesta project` with no arguments and it asks for a name, scans a directory
you choose for git repositories (recursively, so `~/repos/tsoft/platform` is
found), and gives you a checkbox list showing where each one pushes. You can scan
more than one directory before saving.

An entry is either **a path to a clone already on this machine** — preferred —
or a GitHub reference (`owner/repo`, or a bare `repo` for your own account).

With a path, fiesta copies from your clone instead of downloading the repository
again, and reads its `origin` to learn where to push and open PRs — so a repo
under an organisation just works, with no owner to configure. **Your checkout is
only ever read from.** Agents work in a per-ticket copy; an autonomous agent
running `git checkout -B` in a directory you also use would clobber your
uncommitted work and two tickets would fight over one directory.

Whichever form you use, `add` also **verifies the repository is real** (an
existing clone with an `origin`, or a repository that exists on GitHub) and
**creates the matching board label**. Both catch a typo now instead of at 2 a.m.
on the first ticket — a label that does not match the project name exactly
produces a card the daemon rejects with no obvious reason why.

A repository whose clone is out of date gives the agent an out-of-date starting
point; fiesta does not run `fetch` in your checkout, because that is your
directory to manage.

A project of one repository is not a special case; it is the same code path.

**Review feedback comes back to the agent.** While a card sits in `Review`
with an unmerged PR, the daemon polls that PR's comments — general and
inline — and delivers anything new into the still-running agent session,
with the file and line where it applies. The agent pushes to the same
branch rather than opening another PR, and is told to reply on the PR
rather than silently comply when it thinks a comment is wrong. Its own
comments are ignored, so it cannot talk itself into a loop. Comments that
existed the first time the daemon saw the card are treated as already
handled, which means feedback left while the daemon was down is not
replayed — add a new comment to nudge it.

`/workspace` inside the agent container holds one directory per repository of
the project, each on the ticket's branch. The agent changes only what the
ticket needs, opens one draft PR per repository it touched, and the card
reaches `Done` once **all** of those PRs are merged — a partial merge leaves it
in `Review`, because a coupled change is not done until it lands whole.

What this does not solve: `verify-ticket` runs each repository's own tests
separately. A change that can only be proven by running several services
together needs the full stack, which is out of scope here.

A card with zero or more than one label, or one naming an unknown project, is
sent to `Backlog` with the reason posted to the card; fix it and move it back
to `Ready`. `Backlog` is the ignored column, so a rejected card stays put
instead of being cycled back by the orphan rule.

Optionally add a line `base: <branch>` to the card description to target a
base branch other than `main`.

**Nothing the agent publishes names this tooling.** The branch is
`<slug-of-title>-<6 hex>`, where the suffix is derived from the card so a
rerun lands on the same branch — it is not the card id and does not contain
it. Commits are authored as the GitHub user whose token opened the PR, and
the skill forbids mentioning the tool, the board, the card or these
environment variables in a PR title, body, commit message or review reply.
A reviewer sees an ordinary branch from an ordinary colleague.

## Attaching to a running agent

Each in-progress card gets a herdr workspace labeled with the card's Trello
`shortLink`. From your laptop (or anywhere with `herdr` installed and network
access to the herdr server):

```bash
herdr --remote <host>
```

then pick the workspace whose label matches the card's short link to see (or
type into) the live agent session.

## Where data lives

Everything Fiesta needs to survive a reboot lives under the data root,
`/mnt/user/appdata/fiesta` by default. On Unraid, the OS itself runs from RAM
and only `/boot` and `/mnt` survive a restart — so anything the daemon needs
to persist (cloned repo mirrors, per-ticket working directories) must live
under that path, and `.env` (containing live credentials) should be kept
alongside the project checkout on persistent storage, not baked into any
image.

## Testing

```bash
pnpm test
```

## Smoke test

The unit tests prove no module regressed in isolation; they don't prove the
loop works end to end against a real Trello board, a real herdr server, a
real agent container and real Telegram/GitHub round trips. That requires a
disposable board and a disposable repo, on a host that meets every
prerequisite above (in particular one where `~/.claude/.credentials.json`
exists as a file — not macOS, where Claude Code keeps credentials in the
Keychain).

See [`docs/SMOKE_TEST.md`](docs/SMOKE_TEST.md) for the full runbook: two
scenarios (a plain happy path, and a deliberately irreversible-ambiguous
card that exercises the Telegram ask/reply round trip), with an expected,
checkable observation and a most-likely-cause for every step.
