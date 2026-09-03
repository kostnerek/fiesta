# Fiesta

Fiesta is a daemon that watches a Trello board and runs an autonomous coding
agent (Claude Code, in a container) per card. It moves cards through
`Backlog → Ready → In Progress → Review → Done`, and pings Telegram when an
agent needs a human decision.

## Prerequisites

- **Node 22** and **pnpm** (`pnpm@10.29.2`, pinned in `package.json`).
- **Docker** (daemon + CLI) — the daemon shells out to `docker run` to launch
  one container per agent, and uses the docker socket to do so.
- **git** — the daemon clones/mirrors repositories and prepares working
  branches on the host filesystem before handing them to an agent container.
- **A running `herdr` server, reachable from wherever the daemon runs.**
  This is the single most common way to break Fiesta: every `herdr` command
  (workspace create, pane run, pane read, pane send-text, ...) fails with
  `server_not_running` unless a `herdr` server is already up. Start/attach a
  herdr server **before** running `pnpm setup` or starting the daemon, and
  keep it running for the daemon's entire lifetime.
  - The daemon (`src/herdr.ts`) shells out to a `herdr` binary in `PATH`, so
    besides the server being up, the `herdr` **CLI** itself has to be
    reachable from the process that runs `pnpm start`. If you run the daemon
    directly on the host (`pnpm start`), this is whatever `herdr` install you
    already have in your shell's `PATH`.
  - If you run the daemon via `docker-compose.yml` instead, be aware the
    image built from the root `Dockerfile` does **not** bundle a `herdr`
    binary (the design doc leaves "how to durably install herdr on Unraid —
    container vs. user-script" as an open question for a later phase — see
    `docs/superpowers/specs/2026-09-02-fiesta-agent-farm-design.md` §12).
    `docker-compose.yml` uses `network_mode: host` so the container can reach
    a herdr server listening on the host's network/socket, but you still need
    to make the `herdr` CLI executable available *inside* the container
    (e.g. bind-mount the binary into the image, or bake it into a custom
    `Dockerfile` once its distribution story is settled) before `docker
    compose up -d` will work end to end. Until then, running `pnpm start`
    directly on the host — where `herdr` is already installed — is the
    reliable path.

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
docker compose up -d
```

`docker-compose.yml` builds the daemon from the root `Dockerfile`, loads
`.env`, mounts the data root (`/mnt/user/appdata/fiesta`), the docker socket
(so the daemon can launch agent containers), and your Claude credentials
file, and runs with `network_mode: host` (so it can reach Trello/Telegram/
GitHub and a host-local `herdr` server without extra port mapping). Mounting
the docker socket into the *daemon* container is an intentional, contained
trust boundary — the daemon needs it to start agent containers; the agent
containers themselves never see the socket.

Alternatively, run the daemon directly on the host:

```bash
pnpm start
```

This is currently the more reliable option until the `herdr`-in-container
story above is resolved (see Prerequisites).

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
