---
name: verify-ticket
description: Use before opening a pull request — run the repo's own tests, lint and typecheck, then walk the ticket's acceptance criteria one by one with evidence for each.
---

This is the last check before anything ships. Nobody re-reads your work before it becomes a PR — if you claim green here and you're wrong, a broken change goes out unattended. Be skeptical of your own change.

## 0. Verify every repository you changed

`/workspace` holds one directory per repository in this project. Run steps 1 and 2 **in each
repository you changed**, separately — they have their own test commands and their own results.
A repository you did not touch needs no verification.

A change spanning several repositories can only be checked one repository at a time here; if
the acceptance criteria genuinely require them running together, say so plainly in your report
rather than implying you proved something you could not.

## 1. Discover the repo's own commands

Don't assume `npm test` or any other default. Look at `package.json` scripts, a `Makefile`, or the CI config (`.github/workflows/*`, etc.) in this repo and find the actual test, lint and typecheck commands it uses. If a command genuinely doesn't exist in this repo (e.g. no lint is configured), say so explicitly rather than skipping it silently.

## 1a. The end-to-end suites run here — find them and run them

This container has a working Docker daemon (`DOCKER_HOST` is set for you), so a suite
that starts its own containers **runs here**. "No container runtime available" is a
fault to report, not a limitation to note around.

Two ways a repo hides its e2e suite from a careless run:

- **Nx monorepos define two vitest projects per service**, `<service>` and
  `<service>-e2e`. `pnpm nx run <service>:test` runs both. Running vitest yourself
  against `vitest.config.ts` silently runs only the unit half — the config file you
  did not name is the one with the integration coverage.
- **Go e2e files sit behind a build tag**, usually `//go:build e2e`, so a plain
  `go test ./...` skips them without saying so. Pass the tag: `go test -tags e2e ./...`.

Before you decide a suite does not exist, grep for `e2e` in the repo's config and
scripts. Finding none is an answer; not looking is not.

In a workspace where packages are consumed from their built output, the shared package
has to be built before anything that imports it can be typechecked or tested — the Nx
target usually does this for you, but a failure that reads as a missing export is
normally a stale build, not a real type error.

## 2. Run them and paste the output

Run each command you found. Paste the real command output — not a summary of it, the output itself — into your working notes and later into the PR if relevant. Never write "tests pass" or "lint is clean" without the output that shows it. If you didn't run the command, you don't get to claim the result.

## 3. Walk the acceptance criteria one at a time

Take the ticket's acceptance criteria (or, if none are itemized, the concrete behavior the description asks for) and go through them individually. For each one, state:

- **PASS** or **FAIL**
- the evidence — a test that covers it, a command you ran and its output, or a specific code path you traced and why it satisfies the criterion.

Don't bundle criteria together or wave at them collectively. One criterion, one verdict, one piece of evidence.

## Hard rules

- **Never claim something is green without the command output in front of you.** No inference, no "should be fine," no reasoning from the diff alone when a command exists to actually check it.
- **Never report a unit run as if it were the whole suite.** Say which projects, configs or tags you ran, and give the file and test counts. "Tests pass" over a run that skipped every integration test is the failure this skill exists to prevent.
- **A suite you could not run is a finding, not a footnote.** Name the command and paste the error. If it failed because of the environment rather than the change, say that plainly — but never let "it cannot run here" stand unexamined, because here it almost certainly can.
- **Never open a PR while tests are red.** If any test, lint, or typecheck command fails and you cannot fix it, do not proceed to `orchestrate-ticket`'s push/PR steps. End the turn instead with `@@FIESTA:FAIL <reason>`, stating which command failed and why.

This skill either ends by handing control back to `orchestrate-ticket` with a clean bill (all commands green, all acceptance criteria PASS with evidence) or it ends the whole turn with `@@FIESTA:FAIL`. There is no third outcome.
