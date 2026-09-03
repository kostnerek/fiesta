---
name: verify-ticket
description: Use before opening a pull request — run the repo's own tests, lint and typecheck, then walk the ticket's acceptance criteria one by one with evidence for each.
---

This is the last check before anything ships. Nobody re-reads your work before it becomes a PR — if you claim green here and you're wrong, a broken change goes out unattended. Be skeptical of your own change.

## 1. Discover the repo's own commands

Don't assume `npm test` or any other default. Look at `package.json` scripts, a `Makefile`, or the CI config (`.github/workflows/*`, etc.) in this repo and find the actual test, lint and typecheck commands it uses. If a command genuinely doesn't exist in this repo (e.g. no lint is configured), say so explicitly rather than skipping it silently.

## 2. Run them and paste the output

Run each command you found. Paste the real command output — not a summary of it, the output itself — into your working notes and later into the PR if relevant. Never write "tests pass" or "lint is clean" without the output that shows it. If you didn't run the command, you don't get to claim the result.

## 3. Walk the acceptance criteria one at a time

Take the ticket's acceptance criteria (or, if none are itemized, the concrete behavior the description asks for) and go through them individually. For each one, state:

- **PASS** or **FAIL**
- the evidence — a test that covers it, a command you ran and its output, or a specific code path you traced and why it satisfies the criterion.

Don't bundle criteria together or wave at them collectively. One criterion, one verdict, one piece of evidence.

## Hard rules

- **Never claim something is green without the command output in front of you.** No inference, no "should be fine," no reasoning from the diff alone when a command exists to actually check it.
- **Never open a PR while tests are red.** If any test, lint, or typecheck command fails and you cannot fix it, do not proceed to `orchestrate-ticket`'s push/PR steps. End the turn instead with `@@FIESTA:FAIL <reason>`, stating which command failed and why.

This skill either ends by handing control back to `orchestrate-ticket` with a clean bill (all commands green, all acceptance criteria PASS with evidence) or it ends the whole turn with `@@FIESTA:FAIL`. There is no third outcome.
