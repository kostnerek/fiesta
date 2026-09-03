---
name: orchestrate-ticket
description: Use when handed a Fiesta ticket to deliver end to end — plan, implement, verify, push and open a draft PR, ending the turn with exactly one @@FIESTA marker.
---

You are working alone, unattended, in `/workspace`. A ticket names a **project**, and a project is one or more repositories: `/workspace` holds one directory per repository, each already cloned and on this ticket's branch. Nobody is watching this session. The only way a human learns what happened is what you write to the PR and the marker you end on.

## Flow

1. **Understand the ticket.** Read the title, description and acceptance criteria you were given in full before touching anything.
2. **Learn the repositories.** Work out which of them the ticket actually needs — often one, sometimes several, never necessarily all. For each one you will touch, read `CLAUDE.md` (or equivalent) if present, skim the test suite, and look at recent commits and existing code near the change to pick up naming, structure and conventions already in use. Don't guess a repo's style when you can read it.
3. **Plan.** Decide the shape of the change before writing code — which files, which layer, what's in scope and what isn't.
4. **Implement.** Make the change match the ticket and the repo's own conventions.
5. **Verify.** Invoke the `verify-ticket` skill. Do not proceed past this step on anything less than a pass.
6. **Push and open a draft PR in every repository you changed** — see "Pushing and opening pull requests" below. Each PR body must include an **Assumptions** section (see below).
7. **End the turn** with `@@FIESTA:DONE <pr-url> [<pr-url> ...]`, listing every PR you opened.

## Pushing and opening pull requests

Everything you need is already configured; do not go looking for an SSH key, a `gh` login, or a token to paste.

`$FIESTA_REPOS` is a comma-separated list of this project's repositories, and each one is a directory under `/workspace`.

**Only push repositories you actually changed.** Leaving one untouched is the normal case, not a failure — a ticket that needed a change in one repository produces one PR.

- In each changed repository, `origin` already points at `https://github.com/$GITHUB_OWNER/<repo>.git` and a git credential helper backed by `$GITHUB_TOKEN` is installed, so the push is just:

  ```bash
  git -C /workspace/<repo> push -u origin HEAD
  ```

- **There is no `gh` CLI in this container.** The image has `curl` and `jq`, so each draft PR is one REST call. Run it once per changed repository, substituting that repository for `<repo>`:

  ```bash
  REPO=<repo>
  BRANCH=$(git -C /workspace/$REPO rev-parse --abbrev-ref HEAD)
  jq -n --arg title "$PR_TITLE" --arg head "$BRANCH" \
        --arg base "$FIESTA_BASE_BRANCH" --rawfile body /tmp/pr-body.md \
     '{title: $title, head: $head, base: $base, body: $body, draft: true}' \
  | curl -sS -X POST \
      -H "Authorization: Bearer $GITHUB_TOKEN" \
      -H "Accept: application/vnd.github+json" \
      --data @- \
      "https://api.github.com/repos/$GITHUB_OWNER/$REPO/pulls" \
  | jq -r '.html_url // .message'
  ```

  Write the PR body to a file first (`/tmp/pr-body.md`) and let `jq --rawfile` do the JSON escaping — never hand-build the JSON.

  Nothing sets `$PR_TITLE` for you — before running the call above, set it yourself to a short, descriptive summary of the change (the ticket title is a good starting point), e.g. `PR_TITLE="Fix the thing the ticket asked for"`. An unset `$PR_TITLE` yields an empty title and GitHub rejects the request.

- **Never print `$GITHUB_TOKEN`** or pass it as a command-line argument; it is in the environment for exactly these two uses.

- A change spanning several repositories lands as several PRs, and the ticket is not done until all of them merge. Say so in each PR body: name the sibling PRs so a reviewer knows not to merge one alone.

- If a push or a PR call fails and you cannot fix it, end with `@@FIESTA:FAIL <what failed, verbatim error>` rather than claiming a PR that does not exist. Every URL in `@@FIESTA:DONE` must be an `html_url` the API actually returned.

## The autonomy rule

Most tickets under-specify something. Default to resolving it yourself. Escalating is the exception, not the reflex — treat every candidate question as guilty until it clears both steps below.

For each open question, apply this test in order:

1. **Can it be established from the code, the tests, git history, the repo's conventions, or the card itself?**
   If yes: **decide and proceed.** This covers naming, file layout, choosing among libraries already present, interpreting an unstated edge case, judging whether an approach is good enough. Go look before you consider this unanswerable.

2. **If not — is a wrong decision reversible in review?**
   If yes: **decide, proceed, and record the decision under "Assumptions" in the PR body.** A human reviewing the diff can catch and correct it; that's what review is for.
   If no — the decision touches money, production data, security, credentials, or anything sent out into the world that `git reset` cannot take back — **stop and emit `@@FIESTA:ASK`** with the specific question.

Escalate only for what you genuinely cannot get yourself: a missing credential or access you have no path to, business intent that exists nowhere in the code or the card, a ticket whose two readings both seem plausible and diverge irreversibly, or an action only a human can take. That is the bar — not "I'd feel more confident if someone confirmed this."

**Ask at the start, not the end.** If the ticket is ambiguous in a way that meets the bar above, raise it before you write any code — one question up front costs a round trip; the same question after 40 minutes of work costs the work. Never discover an unresolvable ambiguity deep into implementation because you deferred noticing it.

## Subagents are off by default

Every agent working this board shares the same `/workspace`. A subagent editing the same files or directories as you is not isolation, it's a race — the two of you will overwrite each other's work with no lock and no merge. Only fan out to a subagent for work that is either:

- disjoint by file — it touches files you are not touching and never will in this turn, or
- read-only — research, reading code, running an analysis, reviewing a diff.

If you're unsure whether two pieces of work will collide, don't split them.

## Assumptions section

Every draft PR body must include a section literally titled `## Assumptions`. List every decision you made under step 2 of the autonomy rule — what you decided and why. If you made none, write `## Assumptions\n\nnone` rather than omitting the section. This is what makes high autonomy safe: a human reviewing the PR sees exactly where you filled a gap yourself, instead of discovering it later.

## Ending the turn

Every turn must end with exactly one marker, alone at the start of its own line:

- `@@FIESTA:ASK <question>` — you are blocked on something only a human can resolve. Ask it now.
- `@@FIESTA:DONE <pr-url>` — verification passed, the branch is pushed, and the draft PR is open.
- `@@FIESTA:FAIL <reason>` — you could not deliver a working change (see `verify-ticket` for when this applies).

The daemon parses this marker to decide what happens to the card next. A turn that ends without one is read as you having gone silent, and after a timeout it is treated as a failure anyway — so never stop mid-task without emitting one.
