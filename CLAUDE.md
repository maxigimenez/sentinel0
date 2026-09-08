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
  React 19, built on `@16-bits-design/ui`. Organization pages render behind a
  **second-level rail** (`components/OrgRail.tsx`, the design's `showOrgRail`),
  mounted by `AppShell` only on those paths. Named as a sibling of `cloud-api` because
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
| `config.json` | Cloud credentials, Hermes profiles and keys, fallback tracker secrets (v2 schema) |
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
unit-testable. `matchesRule` is *defined as* `explainRule(...) === undefined` rather
than written beside it: a route that silently does nothing is this system's hardest
failure, the cycle summary's `no-route` is equally consistent with a typo'd login and a
transition that was never recorded, and two implementations would drift. `sentinel0
explain` (`GET /routes/explain`) re-collects live triggers and reports the one clause
that rejected each, reading history via `changesSince` and never `observe` — a
diagnostic that advanced the baseline would consume the transition being asked about.

**Matching and targeting fail independently, so explain reports both.** `resolveAgent`
and `explainTarget` are in the rule engine and shared with the dispatcher rather than
duplicated, and explain evaluates the target *whatever* the match did. Reporting only
the first failing match clause hid a live route that named a GitHub identity no profile
claimed: `hermes.profiles[].githubLogin` is the operator's declaration and nothing
verifies it, so the route read as an ordinary "did not match" and would have died as
`unknown-agent` on the day it finally matched. `explainTarget` separates "no agent has
that identity" from "the agent is disabled", and names the profiles missing a
`githubLogin` — preflight's warning about them is easy to miss.

**Transition history belongs to the item, not to the trigger type.** One pull request
raises a `pr_event` and, while a review is outstanding, a `pr_review_requested`;
observations are keyed on `ref` alone and the poll loop observes once per item per
cycle. Keying per type gave the narrower event a baseline that began at the instant of
the transition it existed to detect — first sight reports no changes, and by the next
cycle the reviewer is no longer new — so `pr_review_requested` + `reviewersAdded` could
never fire, the shipped reviewer-agent template included. `pr_event` is emitted for
every open PR regardless, which is what makes its baseline the right one to share.
`migrateObservationKeys` promotes existing `<type>:<ref>` rows so an upgrade does not
reseed a history the install already had.

**First sight and non-existence are different facts** (`triggers/history.ts`). Staying
quiet on first sight is right for backlog and wrong for an item that was *created* since
the last poll, where everything on it really was just added. A bot that opens a pull
request and requests a review three seconds later is never observed without that
reviewer, so the only cycle that could catch the request is the one that suppresses it —
which left the reviewer route dead even after the keying fix. `project_watch` holds a
per-project watermark, the newest creation timestamp seen, in the *provider's* clock on
both sides: comparing GitHub's timestamps against this machine's would make a runner
with a slow clock replay its backlog. It is read once per cycle and advanced after, so
two items opened between the same pair of polls cannot silence each other by ordering,
and it is monotonic because a reopened item can arrive with an older timestamp.

`observeCycle` is the single implementation of that per-cycle step, called by the poll
loop and driven directly by the tests. Both bugs above shipped past a green suite whose
helpers re-implemented the loop — the unit tests handed `changes` to the rule engine and
so could not see that the real pipeline never produced it.

Two invariants the dispatcher enforces:

1. **One run per agent.** Hermes corrupts a profile's memory if two agents drive it
   concurrently. A route targeting a busy agent *defers* without claiming its dedupe
   key, so the trigger survives to the next cycle.
2. **Fire once per change.** Every dispatch claims
   `sha1(routeId, triggerRef, triggerRevision)` in the SQLite `dispatch_ledger` before
   any work starts. `INSERT OR IGNORE` is the concurrency control. A failure before the
   agent was reached releases the claim so a fix can run.

**Two GitHub identities, and only one of them is Sentinel0's.** The *runner's* own
**token** does all the polling, labelling and commenting; each *agent* authenticates as
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

### Tracker credentials (`packages/common/src/github.ts`, `orchestrator/src/integrations/`)

Sentinel0 **does not shell out to `gh`**. It did, and the machine it runs on stopped
being able to install it; the six calls it actually made are plain REST, so
`GitHubRestClient` makes them over `fetch`. It lives in `common` rather than the
orchestrator because the cloud API needs the same three calls to answer the
dashboard's repository and label pickers, and two clients would be two places that
know GitHub's field names.

The token arrives through a **provider function**, never a constructor string. A PAT
is a constant and would not need one; a GitHub App installation token expires roughly
hourly, and the provider is the shape that serves both — moving to an App changes how
a token is obtained and nothing else in the file.

Two REST behaviours that are not `gh` behaviours, and both would fail silently:

- `GET /repos/{o}/{r}/issues` **includes pull requests**; `gh issue list` did not.
  Unfiltered, every open PR also raises a `ticket` trigger.
- `gh`'s `reviewRequests` merged users and teams; REST splits them into
  `requested_reviewers` and `requested_teams`. Reading only the first makes a route
  targeting a review-owning team silently never match.

`getPullRequestDiff` is **gone**, not ported. It had no callers after the Hermes
pivot: fetching a diff is the agent's job under the boundary, and re-adding it here
would cross that boundary in the wrong direction. What Sentinel0 still needs from
GitHub is five calls — list issues, list pulls, ensure/add/remove labels, and post a
comment. Labels are the non-negotiable half: `sentinel0:in-progress` is the loop
guard, and a runner that cannot write labels re-fires every route on every cycle.
The comment exists for `postFailure`, the one case an agent structurally cannot
report on its own behalf.

**Credentials are cloud-owned, and the runner still calls GitHub itself.** The cloud
is a *credential broker*, not a data proxy: `GET /v1/runner/integrations` hands the
runner its tokens, and the runner polls `api.github.com` directly. Proxying the data
too would have made trigger collection stop whenever Railway did, which is precisely
what `routes.json`'s offline cache exists to prevent.

`IntegrationStore` holds them **in memory only**. Routes and projects cache to
`~/.sentinel0/` so an outage cannot stop dispatch, and the same argument applies here
— but a decrypted PAT in a file is a worse trade than a runner that needs its control
plane once at boot. An operator who wants to survive a restart mid-outage sets
`GITHUB_TOKEN` (or `LINEAR_API_KEY`), which is the fallback, not an override: the
cloud wins whenever it has an answer, or a rotated credential would lose to a stale
local one. A failed refresh keeps what was already loaded, for the same reason.

Precedence is **project override, then organization default**, resolved by
`resolveIntegration` in `common` so the cloud and the dashboard cannot disagree
about it.

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

`SENTINEL0_SECRET_KEY` is **required** once any integration is stored: 32 random
bytes, base64 or hex, encrypting tracker credentials with AES-256-GCM. `crypto.ts`
throws rather than deriving a key from nothing, because a deployment that quietly
encrypted every token under a guessable constant would look exactly like a working
one. `GET /v1/runner/integrations` is the only endpoint that returns a plaintext
secret, and is runner-scoped for precisely that reason — the `snt_usr_` key a browser
holds is rejected before the handler runs.

`/v1/integrations/slack` stays a static route and so still wins over the parametric
`/v1/integrations/:provider`. Slack is deliberately not in the `integrations` table:
it authenticates nothing and is never handed to a runner, so folding it in would have
meant a column that is null for one provider and required for the others.

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

A service's `env` block is **reconciled, not merged**: a variable set in the Railway
dashboard and absent from `railway.ts` is *removed* on apply. So every variable a
service reads is declared there with `preserve()`, whether or not it is set today — a
declared name that does not exist yet is a no-op, an undeclared one is a deletion
waiting for the next apply. `SENTINEL0_SECRET_KEY` is the case that made this
concrete: it is required, it can only be set outside source, and losing it makes every
stored credential unreadable. `PORT` stays undeclared because Railway injects it.

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
