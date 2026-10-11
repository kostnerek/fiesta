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

Print `@@FIESTA:STEP qa` on its own line before you bring the stack up.

## 1. Decide whether this ticket needs it

Skip, and say you skipped it, when the change cannot be observed through the API:
a documentation edit, a test-only change, a frontend-only change with no backend
surface. Do not bring up thirteen services to prove a README.

Everything else gets a QA pass.

## 2. Bring the application up — the way this project runs

Projects do not share a way of starting. Pick by what the repository tells you,
in this order:

**The repository ships its own `docker-compose.yml`.** Use it. That file is the
authoritative statement of what the project needs — which database, which
version — and it is almost never the same as another project's. Bring it up with
`docker compose up -d` from the repository root, wait for it to be healthy, then
start the application itself the way its own scripts do. Read `.env.example` for
the configuration it expects and write a `.env` with local values; never copy a
secret from anywhere else.

**Otherwise, if this ticket has a `platform` checkout**, it is the tsoft stack,
whose services carry no compose file of their own:

```
fiesta-stack up
```

That builds the services from your checkout, generates the configuration, starts
them, and waits for the gateway to answer. It takes a few minutes; the build is
cached, so unchanged services cost nothing. If it fails, `fiesta-stack status`
says which service did not start.

**Otherwise there is nothing to run.** Say so and move to the next step rather
than inventing a way to start it.

Either way: a service that fails to start **because of your change** is a QA
failure — report it as one. One that fails for an unrelated reason is worth
naming in your report, but do not spend the ticket fixing it.

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

For the tsoft platform, REST goes to `http://gateway-service:5001/api/v2` — the
only REST surface; every other service is gRPC only, and requests need a JWT and
the `sbe-client-id` tenant header. For any other project, read its own routes;
do not assume this shape.

When the project runs against the **shared** database — the tsoft stack does —
it holds imported production-shaped data used by everything, and two rules
follow. A project that brings up its own database in its own compose owns that
database and these do not apply to it.

- **Scope every case to data you created.** Generate a fresh client or user id
  per case rather than reusing whatever you find. A case that mutates an existing
  row corrupts a dataset that is not yours and cannot be restored short of a
  re-import that takes a quarter of an hour.
- **Never delete rows you did not create**, and never truncate a table.

Record each case as PASS or FAIL with the command, the response, and the query
result. A case you did not run is not a pass.

## 5. Tear it down

```
fiesta-stack down          # the tsoft stack
docker compose down        # a project that brought up its own
```

Run the one that matches what you started, whatever the outcome. Then report:

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
