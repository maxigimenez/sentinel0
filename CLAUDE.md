# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm install          # install all workspace dependencies
pnpm build            # build all packages (tsc)
pnpm test             # run all tests
pnpm lint             # lint all packages
pnpm lint:fix         # auto-fix lint issues

# run a single package's tests
pnpm --filter @sentinel0/orchestrator test
pnpm --filter @sentinel0/cloud-api test
pnpm --filter sentinel0 test
pnpm --filter @sentinel0/cloud-dashboard test

# local development — use this entrypoint for all manual testing
pnpm sentinel0 preflight
pnpm sentinel0 init
pnpm sentinel0 start --api-port 9371 --concurrency 2
pnpm sentinel0 agents
pnpm sentinel0 runs
pnpm sentinel0 stop

# railway — plan/apply reconcile .railway/railway.ts, deploy ships source
pnpm railway:plan
pnpm railway:apply
pnpm railway:deploy:api
pnpm railway:deploy:dashboard

# cloud, against a local or Railway Postgres
DATABASE_URL=... pnpm --filter @sentinel0/cloud-api dev
DATABASE_URL=... pnpm --filter @sentinel0/cloud-api db:migrate

# dashboard, against a local or deployed cloud-api
SENTINEL0_API_URL=http://127.0.0.1:8080 pnpm --filter @sentinel0/cloud-dashboard dev
```

Node.js >= 23.7.0 and pnpm 10.x are required.

## Architecture

Sentinel0 is a **trigger and dispatch layer over [Hermes Agent](https://hermes-agent.nousresearch.com)**.
It watches tickets and pull requests, decides which Hermes agent should start and with
what context, and records what happened. It does not run agents itself.

### The boundary — read this first

Everything else follows from this split:

- **Sentinel0 owns** deciding *when* an agent should start, *which* agent, and *with
  what context*; recording the outcome; announcing it.
- **Hermes owns** everything from the moment a run starts — the filesystem, git,
  worktrees, tooling, credentials, and the agent's own GitHub identity.

Sentinel0 creates no worktrees, runs no git commands, and opens no pull requests. The
agent does that work under its own identity and reports back. Consequently the runner
needs **no local clone** of any repository, and `ProjectConfig` has no `workspaceDir`.

### Package layout

- **`packages/common`** — the shared type spine. `RUN_STATUS`, `AgentDescriptor`,
  `TriggerEvent`, `RoutingRule`, `RunRecord`, and the config shapes. All cross-package
  types live here.
- **`packages/orchestrator`** — the runner. Polls trigger sources, evaluates routes,
  dispatches to Hermes, mirrors runs to the cloud. Runs on the same machine as Hermes.
- **`packages/cli`** — the published `sentinel0` package, the only user entry point.
- **`packages/cloud-api`** — the Railway-deployed control plane. Fastify + Postgres.
  Stores config, the agent registry, and run history; sends Slack notifications.
- **`packages/cloud-dashboard`** — the React app over the cloud user API. Vite +
  React 19, built on `@16-bits-design/ui`. Named as a sibling of `cloud-api` because
  both are hosted; the runner also serves an API, so an unqualified `api` would be
  ambiguous. Deployed to Railway as its own service; see `docs/dashboard.md`.

### The cloud mirror

The runner's SQLite is the source of truth for *decisions*; the cloud is the source of
truth for *watching*, and is usually the only one reachable. So mirroring is durable and
prompt rather than best-effort:

- `MirrorOutbox` is backed by the `mirror_outbox` table and **drains on its own timer**,
  woken by each enqueue. It used to be an in-memory array flushed once per poll cycle,
  behind a 25-second long poll, and dropped on restart — so a finished run could read
  "running" in the cloud indefinitely.
- Run events ship **while the run is live**, batched by high-water id, not once at the
  end. A half-hour run showed an empty log for half an hour.
- On boot, `reconcileOrphans()` asks Hermes about every run a previous process left
  unfinished: terminal there means settle it, still live means `Dispatcher.resume()`
  takes it back — rebuilding the trigger event from the run record so outcomes still
  apply and the in-progress marker is still cleared. Skipping this strands the run *and*
  permanently occupies its agent, since the busy check counts exactly those rows.

Delivery is at-least-once and every mirror write is an upsert, so a duplicate is
harmless where a loss is not.

### Runtime state (`~/.sentinel0/`)

| File | Purpose |
|---|---|
| `config.json` | Cloud credentials, Hermes profiles and keys, secrets (v2 schema) |
| `routes.json` | Last known good routes; the offline fallback, and the whole route table when no cloud is configured |
| `running.json` | Pid and port of the running runner |
| `sentinel0.db` | SQLite — runs, run events, dispatch ledger, observations, mirror outbox |
| `runner.{stdout,stderr}.log` | Runner output |

Override the directory with `SENTINEL0_DATA_DIR`.

### Hermes integration (`packages/orchestrator/src/hermes/`)

One `HermesClient` addresses exactly one profile: the URL prefix (`/p/<name>`, or
nothing for `default`) and the bearer key are bound together at construction, so the
default profile's key can never be presented to a named profile's routes — which
Hermes rejects under `gateway.multiplex_profiles`.

`HermesAdapter.run()` implements the one rule worth remembering: **the SSE stream is
progress, the poll is truth.** Hermes expires run event buffers after five minutes, so
a long run's stream ends while the run continues. Completion is decided exclusively by
polling `GET /v1/runs/{id}`; stream failures are logged and swallowed.

**Approvals are a wait state, not an outcome.** Hermes gates some tool calls behind a
human decision. When the poll sees one, the adapter reports it (`onApprovalRequired`,
carrying what is being asked where Hermes says, and the stream's last tool call where
it does not) and *keeps polling*; answering it is `POST /v1/runs/{id}/approval` with
`{"choice": "once" | "session" | "always" | "deny"}` — Hermes' vocabulary, not ours,
and the fake server in `test/hermes/` validates it as the real gateway does. Two clocks
run: `execution.timeoutSeconds` stops advancing while a person deliberates, and
`execution.approvalTimeoutSeconds` (default one hour) bounds the deliberation, after
which the run is denied and stopped. Returning `awaiting_approval` as a dispatch
outcome — which this did — abandons a live run: nothing polls it again, its ticket
keeps `sentinel0:in-progress` forever, and it holds its agent until someone cancels it
by hand.

### Routing (`packages/orchestrator/src/routing/`)

`trigger → match → target → execution → outcome`. `rule-engine.ts` is pure — no I/O,
no clock — so the whole "which agent starts, and when" decision is exhaustively
unit-testable.

Two invariants the dispatcher enforces:

1. **One run per agent.** Hermes corrupts a profile's memory if two agents drive it
   concurrently. A route targeting a busy agent *defers* without claiming its dedupe
   key, so the trigger survives to the next cycle.
2. **Fire once per change.** Every dispatch claims
   `sha1(routeId, triggerRef, triggerRevision)` in the SQLite `dispatch_ledger` before
   any work starts. `INSERT OR IGNORE` is the concurrency control. A failure before the
   agent was reached releases the claim so a fix can run.

**Two GitHub identities, and only one of them is Sentinel0's.** The *runner's* own
`gh` does all the polling, labelling and commenting; each *agent* authenticates as
itself inside its Hermes profile, and Sentinel0 passes it no token — `createRun` sends
prompt, instructions, session and model, nothing else. `HermesProfileConfig.githubLogin`
is therefore the operator's *declaration* of which account a profile uses, verified by
nothing, and it exists so a route can target an agent by GitHub identity. That gate
matches the login against the item's assignees **or** its requested reviewers: checking
reviewers alone made `pr_event` + `assigneesAdded` + a login target a route the API
would happily save and that could never fire.

`Dispatcher.dispatchPrompt()` is the one path around all of this: an operator's own
prompt against one named agent, from the dashboard's *run agent* button. No rule is
evaluated, nothing is claimed in the ledger, and no label or comment is written —
there is no trigger to re-observe and no ticket to write to. Invariant 1 still holds,
but a manual run against a busy agent is **refused** rather than deferred, because
nothing will retry it and the person who pressed the button is owed the reason. The run
records `routeId: 'manual'` and `triggerType: 'manual'`; inventing a plausible route id
would be worse than saying there was not one.

### Route catalog (`packages/common/src/route-catalog.ts`)

The supported cases are declared once, as complete routes, and served from
`GET /v1/route-templates` for the dashboard to offer. Adding a capability means
adding a template here; `test/routing/route-catalog.test.ts` checks every entry
against `validateRoutingRule` and the prompt renderer, so a template can never
ship in a shape the API would reject. `docs/routes.md` is the prose counterpart.

### Cloud (`packages/cloud-api`)

Two API-key scopes, separated from day one: `snt_rnr_` for the runner
(`/v1/runner/*`), `snt_usr_` for humans and the future dashboard (`/v1/*`). Presenting
one where the other is required is a 401.

The runner **long-polls** `GET /v1/runner/commands` rather than accepting inbound
connections, so it works behind NAT with no tunnel. Commands are *addressed*: one
carrying a `runner_id` reaches only that runner, one carrying none is a broadcast. The
poll and the ack both pass `runner=<name>`, and the ack must — acking by cursor alone
marks another runner's addressed commands delivered before it ever fetched them.

Commands that start an agent are started and *not* awaited by the poll loop — a run can
take half an hour, and awaiting one would stop the runner collecting triggers and stop
its heartbeat, so the dashboard would report it stale for exactly as long as it was busy.
`cancel` and `resync` are awaited, because they must have taken effect before the next
cycle reads what they changed.

That poll also paces the runner's main loop, but **health does not ride on it**:
`POST /v1/runner/heartbeat` runs on its own 15-second timer, because a cycle takes as
long as the work in it and a busy runner used to look like a dead one against the
90-second staleness window. Nothing can ask the runner how it is doing, so health is
pushed or it does not exist; the heartbeat also carries per-agent status and a bounded
tail of skipped routing decisions, neither of which the cloud could otherwise know.
`last_seen_at` is additionally touched by any authenticated runner request that names
its runner — the filter matters, since updating every row in the org marks a machine
that has been off for a week alive the moment another runner polls.

CORS on the user API must list its methods explicitly. `@fastify/cors` defaults to
`GET,HEAD,POST`, which makes a browser's preflight refuse every DELETE and PUT while
curl, sending no preflight, works perfectly.

Migrations are plain `.sql` files applied in filename order, one transaction each.

`DASHBOARD_URL` is optional and only used to deep-link a run from Slack. Without it the
needs-approval message still names the `sentinel0 approve` command — a notification that
says a decision is required and no way to make one is the failure this replaced.

## CI and releasing

Four workflows in `.github/workflows`: `ci.yml` (lint, typecheck, test),
`deploy-cloud-api.yml` and `deploy-dashboard.yml` (Railway), `publish-cli.yml` (npm).
`docs/releasing.md` covers secrets and the manual fallbacks.

**Only CI runs on push.** Both deploys are `workflow_dispatch` only — merging and
shipping are separate decisions, and a deploy interrupts every runner's long poll.
Neither declares a GitHub environment; `publish-cli` declares `npm` because npm's
trusted publisher is configured against that name.

The Node matrix is load-bearing, and only for the tests: 22 needs
`--experimental-sqlite` and 24 ignores it, so both must run for the supported range to
mean anything. Lint and typecheck read no runtime API and pin their own `@types/node`,
so they cannot differ between the two and run on the `primary: true` row alone — the
flag is on the matrix row rather than matched against a version string, so bumping the
newest Node cannot silently stop linting. The floor is 22.12 rather than 22.11 because
Vite 8, which builds the dashboard, requires it. CI builds before testing because one
suite imports the built package to catch circular imports the source alias hides.

**Nothing in CI builds the Docker images.** `railway up` uploads source and Railway
builds, so the images were only ever built here to fail early — at a minute apiece on
every pull request, including the ones that touch no Dockerfile. A broken `Dockerfile`
or `Dockerfile.dashboard` now surfaces during a manual deploy. Build one locally
(`docker build -f Dockerfile.dashboard .`) before deploying a change to either.

Both Railway services are declared in `.railway/railway.ts` — Railway's Infrastructure
as Code, which replaced the per-service `railway.json` files. Config as Code is
deprecated: services could no longer opt in from 2026-08-28, and it retires on
2026-12-01. One file for the whole project is also what makes the failure it replaced
unrepresentable — with no root `railway.json`, a new service cannot inherit another's
builder and silently deploy the wrong image.

`pnpm railway:plan` previews; `pnpm railway:apply` applies after review. Neither
deploys — `pnpm railway:deploy:api` and `pnpm railway:deploy:dashboard` do that, and
they reconcile no configuration, so a change to `.railway/railway.ts` needs an apply
as well.

## Key conventions

- **Fail fast**: missing required config or malformed input throws immediately — no
  silent fallbacks.
- **Strict parsing**: all CLI arg and request parsing goes through dedicated parser
  functions in `args.ts`; never parse inline. An unknown flag is an error.
- **`pnpm sentinel0 <command>`** is the canonical local testing entrypoint.
- Runner console lines are stamped with an ISO-8601 UTC instant, and a run event's
  echoed line reports the time the event was *recorded* rather than a fresh clock read,
  so the log and the stored event never disagree about when something failed.
- **Docs updates belong in the same commit** as behavior changes.
- Tests live in `packages/<name>/test/` and mirror the `src/` structure.
- The dashboard runs on a custom `@16-bits-design/ui` theme (`noir` — neutral surfaces,
  violet accent), defined in `src/theme-noir.css` and pinned by `test/theme.test.ts` —
  a token a theme forgets silently inherits the library's ember default rather than
  erroring.
- The dashboard's screen tests run against payloads recorded from a live `cloud-api`
  over real Postgres, in `test/fixtures/`. Hand-written ones agree with the source by
  construction and miss what actually breaks a browser — `run_events.ts` arrives as a
  string, because node-postgres will not narrow a bigint.
- Prefer testing pure logic directly. `test/hermes/fake-hermes-server.ts` exists so the
  adapter's timeout, cancellation, and degradation paths are testable without a real
  Hermes; it can misbehave on demand.
