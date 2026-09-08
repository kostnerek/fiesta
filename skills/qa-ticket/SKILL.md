---
name: qa-ticket
description: Exercise the change against a running application — bring the stack up on this ticket's own code, write test cases from the acceptance criteria, run them over the real API, verify each against the database, then tear the stack down. Use after verify-ticket passes and before opening a pull request.
---

`verify-ticket` proves the test suites are green. This proves the change works in
a running application, which a suite of mocks cannot.

**The stack runs your code, not a pristine checkout.** It mounts this ticket's
workspace, so what you exercise is what you are about to push.

**Bring it up, use it, put it away.** The stack is not left running: the next
ticket must not inherit your processes, your ports, or your half-finished state.
Tear it down even when the QA pass fails — especially then.

## 1. Decide whether this ticket needs it

Skip, and say you skipped it, when the change cannot be observed through the API:
a documentation edit, a test-only change, a frontend-only change with no backend
surface. Do not bring up thirteen services to prove a README.

Everything else gets a QA pass.

## 2. Bring the stack up

```
fiesta-stack up
```

That builds the services from your checkout, generates the configuration, starts
them, and waits for the gateway to answer. It takes a few minutes; the build is
cached, so unchanged services cost nothing.

If it fails, `fiesta-stack status` says which service did not start. A service
that fails to boot **because of your change** is a QA failure — report it as one.
A service that fails for an unrelated reason is worth naming in your report, but
do not spend the ticket fixing it.

## 3. Write the cases before you run anything

From the ticket's acceptance criteria, write out the cases first — in your notes,
not in the repository. For each one:

- the exact `curl` or `grpcurl` command, with its request body
- what the response should be
- **the SQL that proves it**, against the shared database

A case with no database check is not a case. The response is what the service
claims; the row is what actually happened. Assert on the row.

Cover, where the change touches them: the happy path; each acceptance criterion
separately; authorisation (no token, wrong tenant, insufficient role); the
boundaries the change introduces; and, for anything touching money or state that
two requests can reach at once, the concurrent case.

## 4. Run them and record what happened

REST goes to `http://gateway-service:5001/api/v2` — the only REST surface; every
other service is gRPC only. Requests need a JWT and the `sbe-client-id` tenant
header.

The database holds **imported production-shaped data**, shared by everything.
That has two consequences you must respect:

- **Scope every case to data you created.** Generate a fresh client or user id
  per case rather than reusing whatever you find. A case that mutates an existing
  row corrupts a dataset that is not yours and cannot be restored short of a
  re-import that takes a quarter of an hour.
- **Never delete rows you did not create**, and never truncate a table.

Record each case as PASS or FAIL with the command, the response, and the query
result. A case you did not run is not a pass.

## 5. Tear it down

```
fiesta-stack down
```

Run this whatever the outcome. Then report:

- each case with its verdict and its evidence
- any service that would not start, and whether your change caused it
- what you could not cover, and why

## Hard rules

- **Never report a QA pass for a case you did not run.** The command and its
  output, or it did not happen.
- **Never leave the stack running.** `fiesta-stack down` is not optional, and a
  failed pass is exactly when it is most tempting to skip it.
- **Never mutate data you did not create.** The database is shared and is not
  restorable within a ticket.
- **A QA failure blocks the pull request.** End the turn with `@@FIESTA:FAIL`
  naming the case that failed and what it returned, exactly as `verify-ticket`
  does for a red suite.
