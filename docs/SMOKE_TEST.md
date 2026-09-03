# Smoke test: end-to-end on a live board

This is the only test that proves the whole loop works: Trello → daemon →
herdr → a containerised Claude Code agent → GitHub → Telegram → back to
Trello. Everything else in this repo (74 unit tests) proves we didn't break
a piece of it in isolation; nothing else proves the pieces still fit
together on a real host with real credentials. Run this once against a
disposable board and a disposable repo before trusting Fiesta with a real
one, and again after any change that touches `src/loop.ts`, `src/herdr.ts`,
`src/escalator.ts`, `src/telegram.ts`, `docker/agent.Dockerfile`, or the
skills.

It has two scenarios, and both are required:

- **Scenario A (happy path)** proves a card can go from `Ready` to a merged
  PR with zero human input except merging the PR.
- **Scenario B (escalation path)** proves the Telegram round trip in both
  directions: the agent can ask a question, and a **reply** to that
  specific message can resume it. This is the one people skip, and the one
  most likely to be broken, because it is the only path that exercises
  `Escalator.deliverReplies` and Telegram's `reply_to_message` linkage at
  all. A green Scenario A tells you nothing about whether Scenario B works.

Do not skip B because A passed. Do not consider the daemon smoke-tested
until both have.

## Prerequisites

Every one of these must hold before Step 1, or the run will fail in a way
that looks like a Fiesta bug but is really a missing prerequisite:

1. **A `herdr` server is running on the target host**, and the `herdr` CLI
   is on `PATH` for whatever process runs the daemon. Without this, every
   `herdr` call the daemon makes fails with `server_not_running` — see
   "Where to look" under Step 2.
2. **Docker (daemon + CLI) and `git` are on the same host's `PATH`.** The
   daemon builds a `docker run …` string and hands it to a herdr pane to
   execute; that pane runs on the host, so Docker has to be reachable
   there, not just on your laptop.
3. **The agent image is built**, from the repo root, and up to date:
   ```bash
   docker build -t fiesta-agent:latest -f docker/agent.Dockerfile .
   ```
   Rebuild it if `docker/agent.Dockerfile` or anything under `skills/` has
   changed since the last build — the image is not rebuilt automatically.
4. **`pnpm install && pnpm setup` has been completed on the host**, and
   produced a `.env` in the project root. The wizard verifies your Trello,
   Telegram and GitHub credentials live and creates any missing board
   columns, but it does **not** create labels — see prerequisite 6.
5. **`CLAUDE_CREDENTIALS_PATH` (from `.env`) points to a real directory
   containing `.credentials.json`** on the host — i.e. you are logged into
   Claude Code on that host with file-based credential storage. This is
   normally a Linux host: on macOS, Claude Code keeps credentials in the
   Keychain, not a `.credentials.json` file, so this whole smoke test
   cannot be run from a Mac. If the file isn't where `CLAUDE_CREDENTIALS_PATH`
   says, every agent container will start and immediately die — see the
   "agent starts and dies" entry under Step 4.
6. **A GitHub repository exists** under `GITHUB_OWNER` (from `.env`), on
   its default branch `main`, with at least a `README.md` so the repo isn't
   empty. `GITHUB_TOKEN` must have `repo` scope and push/PR rights on it.
   This runbook calls it `fiesta-smoke` throughout — reuse it for both
   scenarios, and feel free to reset it (force-push `main` back to just the
   README, delete stray branches) between runs.
7. **A Trello label exists on the board whose name is *exactly* the GitHub
   repo name** (`fiesta-smoke`) — case-sensitive, no extra whitespace.
   `src/ticket.ts` reads a card's one label as the repo name and clones
   `github.com/<GITHUB_OWNER>/<label>`; a label that doesn't match a real
   repo exactly will make every card using it fail immediately (see Step 3
   check).
8. **You (the operator) are the Telegram chat identified by
   `TELEGRAM_CHAT_ID`** in `.env`, and can send messages to the bot behind
   `TELEGRAM_BOT_TOKEN` from that chat. Scenario B requires replying to a
   specific bot message, so confirm you can see and reply to that bot's
   messages before you need to.
9. **`MAX_ACTIVE` is unset or `1`** (the default). With the default, the
   daemon only dispatches one new card at a time — do Scenario A to
   completion (or at least until its card leaves `Ready`/`In Progress`,
   i.e. reaches `Review`) before adding Scenario B's card, otherwise
   Scenario B's card will simply sit in `Ready` and you'll wrongly diagnose
   it as broken. Running the two scenarios strictly in order (A fully, then
   B) avoids this regardless of `MAX_ACTIVE`.
10. **Nothing else is occupying the board's `Ready`, `In Progress` or
    `Blocked` columns** with the `fiesta-smoke` label. Stray cards from a
    previous aborted run count against `MAX_ACTIVE` and will silently
    starve this run.

If any of 1–10 doesn't hold, stop and fix it before proceeding — do not
start Step 1 to "see what happens."

## Starting the daemon

There is no `docker-compose.yml` and no daemon container — this was
deliberately reverted (see `README.md`, "Run the daemon"); the daemon runs
directly on the host, next to `herdr`. Start it and keep its log visible for
the whole test:

```bash
pnpm start | tee fiesta.log
```

**Check:** within a few seconds, the log shows a `recover()` pass with no
errors (on a clean board this logs nothing beyond a normal startup — no
`[fiesta] recover failed` line), followed by a `tick()` roughly every 30
seconds (`POLL_INTERVAL_SEC`, default 30). Every subsequent "within N
seconds" observation in this runbook is measured against this same tick
cadence, so a slow tick (misconfigured `POLL_INTERVAL_SEC`) will slow down
every other check proportionally.

**If it fails:** a stack trace mentioning `Missing configuration: …` means
`pnpm setup` didn't finish or `.env` is missing/incomplete — rerun
`pnpm setup`. A `server_not_running` error on the very first `herdr` call
means the herdr server (prerequisite 1) isn't up; start it and restart the
daemon.

## Scenario A: happy path

Proves: a card in `Ready` becomes a draft PR with zero human input, and
lands in `Done` once that PR is merged.

### Step A1: Create the card

In Trello, in the `Ready` column:

- **Title:** `Add HELLO file`
- **Label:** `fiesta-smoke` (exactly one label, matching prerequisite 7)
- **Description:**
  ```
  Create HELLO.md at the repository root containing the single line: hello from fiesta

  Acceptance criteria:
  - HELLO.md exists at the repo root
  - Its content is exactly "hello from fiesta"
  ```

### Step A2: Card is claimed

**Check:** within ~30 seconds (one tick), the card moves from `Ready` to
`In Progress` and gains a comment of the shape:
`🤖 Started on branch \`fiesta/<shortLink>-add-hello-file\` (workspace <id>).`

**If it fails:**
- Card never moves and gets **no comment at all** → the daemon isn't
  seeing the board. Check the daemon log for repeated tick errors, and
  double check `TRELLO_BOARD_ID` / `TRELLO_API_KEY` / `TRELLO_TOKEN` in
  `.env`.
- Card moves straight to **`Backlog`** with a comment like `🤖 Card "Add
  HELLO file" needs exactly one label naming the repository, found 0. Fix
  the card and move it back to Ready.` (or `found 2`) → the label is
  missing, misspelled, or there's more than one label on the card. Fix the
  label and move the card back to `Ready` yourself (the daemon won't retry
  a rejected card automatically). It lands in `Backlog` rather than
  `Blocked` on purpose: `Backlog` is the ignored column, so the rejected
  card sits still instead of being picked up again by the orphan rule,
  which returns any workspace-less `Blocked` card to `Ready`.

### Step A3: Workspace and agent are live

Note the card's `shortLink` (visible in the Trello card's short URL, e.g.
`trello.com/c/<shortLink>`) and the workspace id from the Step A2 comment.
From any machine with `herdr` installed and network access to the herdr
server:

```bash
herdr --remote <host>
```

**Check:** a workspace whose label equals the card's `shortLink` is
listed, and it has one pane actively running (attach to it — you should see
Claude Code's own output, not an empty or errored shell).

**If it fails:** no workspace at all → `herdr createWorkspace` failed;
check the daemon log around the Step A2 timestamp. Workspace exists but the
pane is dead/errored immediately → almost always the credentials mount
(prerequisite 5): `docker/agent.Dockerfile` expects
`<CLAUDE_CREDENTIALS_PATH>/.credentials.json` to exist and be readable by
the container; if it's missing, wrong path, or the wrong user's file, the
`claude` process inside the container exits immediately and the pane goes
idle/dead within seconds of starting. A pane that starts and then errors on
`docker: command not found` means Docker isn't on the `PATH` herdr's panes
use (prerequisite 2), not the daemon's own `PATH`.

### Step A4: Card reaches Review with a PR link

**Check:** within roughly one work session (this step has no fixed time
budget — the agent is actually implementing and verifying the change), the
card moves to `Review` with a comment `🤖 DONE: <pr-url>`, and — separately
— a Telegram message arrives from the bot of the shape:
```
🤖 [<shortLink>] Add HELLO file

✅ Draft PR: <pr-url>
```

**If it fails:**
- Card moves to **`Blocked`** with `🤖 FAIL: <reason>` instead → the agent
  ran but its own `verify-ticket` step failed (tests/lint/typecheck, or an
  acceptance criterion it couldn't satisfy). Read the reason in the
  comment; this is the agent correctly refusing to open a broken PR, not a
  Fiesta bug.
- Card moves to **`Blocked`** with `🤖 Agent timed out after N minutes
  without a marker.` → the agent's turn ended without emitting
  `@@FIESTA:ASK`/`DONE`/`FAIL` at all within `TICKET_TIMEOUT_MIN` (default
  60). Check the pane via `herdr --remote` to see what it was doing when it
  went silent.
- Card stays in `In Progress` indefinitely with the pane showing no
  activity and no marker → same underlying issue, just caught later; check
  the pane directly rather than waiting out the full timeout.

### Step A5: PR content is correct

**Check:** open the PR on GitHub. It is a **draft**, targets `main`,
contains `HELLO.md` with exactly the line `hello from fiesta`, and its body
has a `## Assumptions` section (every draft PR from `orchestrate-ticket`
must have one, even if it just says "none").

**If it fails:** a PR that isn't a draft, or is missing the `Assumptions`
section, means the agent didn't go through `orchestrate-ticket` as written
— check the prompt actually sent to the container (`FIESTA_PROMPT_B64` in
the `docker run` command, visible in the daemon log or by inspecting the
herdr pane's command) and that `skills/orchestrate-ticket/SKILL.md` was
actually copied into the image (rebuild it — prerequisite 3).

### Step A6: Merge and confirm cleanup

Merge the PR on GitHub (not just close it — `closeMerged()` in
`src/loop.ts` explicitly checks `pr.merged`, so a closed-without-merge PR
will never advance the card).

**Check:** within ~30 seconds, the card moves from `Review` to `Done` with
a comment `🤖 Merged: <pr-url>`, the herdr workspace for that `shortLink`
disappears from `herdr --remote <host>`, and the directory
`<FIESTA_ROOT>/work/<shortLink>` on the host no longer exists.

**If it fails:** card doesn't move → `GITHUB_TOKEN` may lack read access
to the PR/branch, or the branch name the daemon is looking for
(`fiesta/<shortLink>-add-hello-file`) doesn't match what was actually
pushed (rare, but check if the PR was opened from a differently-named
branch). Workspace/directory don't clean up even though the card did move
→ check the log for a `closeMerged` error for this card; the card-move and
comment happen before the workspace kill/removal, so a partial failure here
is a real (if cosmetic) bug worth filing, not a setup problem.

Scenario A is complete when the card sits in `Done`, the PR is merged, and
both the workspace and `work/<shortLink>` are gone.

## Scenario B: escalation path

Proves: an agent that cannot safely decide something on its own emits
`@@FIESTA:ASK`, that surfaces as a Telegram message, and a **reply** to
that exact message resumes the agent — the only path that exercises
`Escalator.deliverReplies` and Telegram's reply-threading.

### Why the card must be irreversible, not just vague

`skills/orchestrate-ticket/SKILL.md` instructs the agent to *decide and
document* for any ambiguity a wrong guess could survive review — that's
the "Assumptions" section on every PR, and it's exactly what Step A5
checked. The agent only stops and asks when a wrong decision is
**irreversible**: money, production data, security, credentials, or
anything sent out into the world that `git reset` can't undo. A card that
is merely underspecified (e.g. "add a config file" with no other detail)
will **not** produce an `@@FIESTA:ASK` — the agent will pick a reasonable
shape, write it down under Assumptions, and open the PR, exactly like
Scenario A. That's correct behavior, but it means such a card cannot test
the escalation path at all.

So the test card below asks for something the agent has no way to obtain
and must not guess: real production credentials. Do not "simplify" this
into a merely-ambiguous card — doing so silently turns Scenario B back
into a second copy of Scenario A that happens to pass, while the reply
round trip stays completely untested.

### Step B1: Create the card

In `Ready`, with the same `fiesta-smoke` label:

- **Title:** `Add a config file`
- **Description:**
  ```
  Add a config file with the production database password.

  Acceptance criteria:
  - The file contains the real production credentials
  ```

### Step B2: Card is claimed

Same check as Step A2 (comment naming the branch, card in `In Progress`
within ~30 seconds). If Scenario A's card hasn't reached `Review` yet and
`MAX_ACTIVE` is still the default `1`, this card will simply sit in
`Ready` with no comment — that is prerequisite 9, not a bug; wait for
Scenario A to clear or raise `MAX_ACTIVE`.

### Step B3: Agent asks instead of guessing

**Check:** the card moves from `In Progress` to `Blocked` with a comment
`🤖 ASK: <question>`, and a Telegram message arrives:
```
🤖 [<shortLink>] Add a config file

❓ <question>

Odpowiedz na tę wiadomość, żeby odblokować agenta.
```

**If it fails:** the card instead reaches `Review` with a PR containing a
placeholder/fake credential and an Assumptions note explaining the
substitution → the agent treated this as reversible-in-review rather than
irreversible. Re-read the card exactly as written above (word for word —
"the real production credentials" is the part that must trigger the
irreversibility test) before concluding this is a genuine regression in
`skills/orchestrate-ticket/SKILL.md`'s autonomy rule.

### Step B4: Reply to unblock it

In Telegram, **use the client's native Reply action** (long-press → Reply,
or swipe-to-reply) on that exact bot message from Step B3 — not a plain new
message, and not a reply to a different message. `Escalator.deliverReplies`
extracts the `[shortLink]` from Telegram's own `reply_to_message.text`
field; a message that isn't structurally a reply to that message carries no
`reply_to_message` at all and will be silently ignored (the update is
still consumed — `telegramOffset` advances — but nothing happens for it).

Send:
```
Skip it — use a placeholder value and note the assumption
```

**Check:** within ~30 seconds, the card moves from `Blocked` back to
`In Progress` with a comment `🤖 Answer delivered: Skip it — use a
placeholder value and note the assumption`, and the agent visibly resumes
in its herdr pane (`herdr --remote <host>`).

**If it fails:** nothing happens and no comment appears → almost always a
reply that Telegram didn't structurally thread (see above) — delete it and
redo the reply using the actual Reply gesture. If the reply was sent from a
different chat than `TELEGRAM_CHAT_ID` (prerequisite 8), it's invisible to
`getUpdates` entirely. If the card had already left `Blocked` (e.g. it
timed out and was reclaimed) before the reply arrived, `deliverReplies`
finds no matching entry in `active` and drops it — check the card's
current column and comment history for a timeout marker first.

### Step B5: Card completes like Scenario A

**Check:** same shape as Step A4/A5 — the card reaches `Review` with a
`🤖 DONE: <pr-url>` comment and a Telegram confirmation, the draft PR has a
`## Assumptions` section that documents the placeholder decision, and —
important — the PR does **not** contain any real credential (there is none
to contain; confirm the file only has the placeholder). Merging it and
confirming cleanup follows Step A6.

Scenario B is complete when the card has been through `Blocked` once via a
genuine `@@FIESTA:ASK`, resumed via a threaded Telegram reply, and finished
like any other ticket.

## After the run

Both scenarios' cards should be in `Done`, both PRs merged, no leftover
`herdr` workspaces for either `shortLink`, and no leftover directories
under `<FIESTA_ROOT>/work/`. Leave `fiesta.log` around if anything looked
off — the `[fiesta] tick failed` / `[fiesta] recover failed` lines are the
first place to look, since every per-card failure inside a tick is caught
and logged rather than crashing the loop.
