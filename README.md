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
  up. Start/attach a herdr server **before** running `pnpm setup` or
  starting the daemon, and keep it running for the daemon's entire
  lifetime. The daemon (`src/herdr.ts`) shells out to a `herdr` binary in
  `PATH`, so it needs to be on the same `PATH` as the process running
  `pnpm start`.

## Setup

```bash
pnpm install
pnpm setup
```

`pnpm setup` is an interactive, idempotent wizard. It:

- checks that `herdr`, `docker` and `git` are on `PATH`;
- walks you through Trello (API key + token), creates any missing board
  columns (`Backlog`, `Ready`, `In Progress`, `Blocked`, `Review`, `Done`);
- walks you through Telegram (bot token, auto-detects your chat id) and
  GitHub (token, scope `repo`);
- asks for the data root (defaults to `/mnt/user/appdata/fiesta`) and your
  Claude credentials directory (defaults to `~/.claude`);
- writes all of this to `.env` in the project root, `chmod 600`.

`.env` holds live credentials. It is git-ignored and must **never** be baked
into a container image.

## Build the agent image

Every card is worked by a fresh, throwaway container built from
`docker/agent.Dockerfile`. Build it once (and rebuild whenever it changes):

```bash
docker build -t fiesta-agent:latest -f docker/agent.Dockerfile docker/
```

This image contains `git`, `curl`, `jq` and the `claude` CLI, plus an
`entrypoint.sh` that configures git identity, decodes the base64-encoded
prompt from `FIESTA_PROMPT_B64`, and launches
`claude --dangerously-skip-permissions <prompt>`. The daemon mounts your
Claude credentials **file** (not the whole directory) read-only into it at
`/home/agent/.claude/.credentials.json`; `/home/agent/.claude` itself stays a
real, writable directory owned by the `agent` user inside the image so that
mount only overlays the one file.

## Run the daemon

```bash
pnpm start
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
`pnpm start` will still be running after a restart unless something
restarts them. Wiring that up — a user script, a system service, or
whatever mechanism you already use for other long-running processes on the
box — is on the operator; this repo doesn't prescribe one. Whatever you
pick, make sure it starts `herdr` before it starts the Fiesta daemon.

If a containerised daemon is wanted later, the compose file and root
Dockerfile from an earlier iteration of this doc are one `git revert` away
in this branch's history — but they'd need herdr's socket and CLI solved
first, not just resurrected as-is.

## Adding a repository

There is no repository registration step. A card is assigned to a repository
by giving it **exactly one label** whose name is the repository name (e.g.
`tsoft`). The daemon reads that label via `src/ticket.ts` and clones/mirrors
`github.com/<GITHUB_OWNER>/<label>`. A card with zero or more than one label
is rejected with an error posted back to the card.

Optionally add a line `base: <branch>` to the card description to target a
base branch other than `main`.

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
