# Cloud API reference

Base URL is your Railway deployment. Every endpoint below except `/health` needs a
bearer token.

## Authentication

Two key scopes, and they are not interchangeable — a runner key presented to a
management endpoint is rejected, and vice versa. That separation is the only thing
standing between an unattended daemon's credential and a human's.

| Scope | Prefix | Used by | Reaches |
|---|---|---|---|
| `user` | `snt_usr_` | You and the dashboard | `/v1/*` management endpoints |
| `runner` | `snt_rnr_` | The runner on the Mac Mini | `/v1/runner/*` only |

```
Authorization: Bearer snt_usr_…
```

Keys are stored as SHA-256 hashes. The plaintext is shown once, at creation, and is
not recoverable.

---

## Bootstrap

The first key cannot come from the API, because minting keys requires one. It comes
from a one-off command run against the deployment:

Run it inside the deployed container, where `DATABASE_URL` resolves:

```bash
railway ssh --service api        # your service name
# then, in the container:
node dist/org-cli.js --name "Your Company"
node dist/org-cli.js --list
node dist/org-cli.js --org org_abc123 --add-key runner
```

Or from a local checkout, against the database's **public** URL — Railway's
`DATABASE_URL` points at an internal host that only resolves inside the platform:

```bash
pnpm --filter @sentinel0/common build && pnpm --filter @sentinel0/cloud-api build
cd packages/cloud
DATABASE_URL="$(railway variables --service Postgres --kv | grep DATABASE_PUBLIC_URL | cut -d= -f2-)" \
  node dist/org-cli.js --name "Your Company"
```

After that, manage keys through the API.

---

## Health

```http
GET /health
```

Unauthenticated, because Railway's health check runs before any key exists.

```json
{ "status": "ok", "version": "0.0.1" }
```

---

## Identity

```http
GET /v1/me
```

Resolves the presented key to the organization behind it.

```json
{
  "org": { "id": "org_abc123", "name": "Your Company", "createdAt": "2026-08-01T00:00:00.000Z" },
  "key": { "id": "key_abc123", "name": "dashboard", "prefix": "snt_usr_9f2a41c8", "scope": "user" }
}
```

This exists for the dashboard, where a key is the whole of sign-in: it has to be able
to check one *before* storing it, and to show whose organization it opened. Any other
endpoint would answer the "is this key valid" half, but none names the organization,
and picking an arbitrary one to probe with would make an unrelated endpoint's failure
look like a rejected key.

A runner key here is a `401`, like anywhere else under `/v1/`.

---

## Keys

```http
GET    /v1/keys
POST   /v1/keys        { "name": "ci", "scope": "runner" | "user" }
DELETE /v1/keys/:id    revokes; the row stays for the audit trail
```

`POST` responds with the plaintext key. It is never shown again.

```json
{ "id": "key_…", "key": "snt_rnr_…", "scope": "runner", "prefix": "snt_rnr_a1b2c3d4" }
```

---

## Projects

What the runner should watch. A project is a ticket source, nothing more — there is no
local clone and no agent attached to it.

Projects live here, not in the runner's local config: `sentinel0 init` never writes
them. A runner with no projects polls nothing, so nothing can ever trigger.

```http
GET    /v1/projects
POST   /v1/projects
DELETE /v1/projects/:id
```

```jsonc
// Linear
{ "id": "taplands", "provider": "linear", "filters": { "team": "ENG" } }

// GitHub
{ "id": "www", "provider": "github",
  "filters": { "owner": "acme", "repo": "www", "state": "open" } }
```

`filters` is a coarse pre-filter applied **at the source**, before routing sees
anything. A route can only ever match a ticket a filter let through, which makes an
over-narrow filter the most common reason a correct-looking route never fires. If a
route matches on `labels`, leave `filters.labels` unset and let the route decide.

---

## Routes

The core abstraction: **when this happens, start that agent, then do this with the
result.**

Every supported case, with a ready-made route for each, is in
**[routes.md](./routes.md)**. What follows is the wire format.

```http
GET    /v1/routes
POST   /v1/routes        create, or update by passing an existing id
DELETE /v1/routes/:id
```

```jsonc
{
  "id": "rt_product_review",        // omit to have one generated
  "name": "Product review on feasibility label",
  "priority": 100,                  // highest wins; ties break on id
  "enabled": true,

  "guard": {
    "refire": "once",               // once | per-change
    "markers": true                 // apply sentinel0:* labels around the run
  },

  "trigger": {
    "type": "ticket",               // ticket | pr_event | pr_review_requested | manual
    "provider": "linear",           // optional; omit to match either provider
    "projectId": "taplands"
  },

  "match": {                        // every clause must hold
    "labels": { "any": ["feasibility"], "none": ["blocked"] },
    "state":  { "any": ["Backlog"] },
    "assignees": { "any": ["acme-bot"] },
    "titleMatches": "^RFC:",        // regex against the title
    "bodyMatches": "billing",       // regex against the description

    // pull requests only
    "isDraft": false,
    "baseBranch": { "any": ["main"] },

    // transitions — what changed since the last poll
    "labelsAdded":    { "any": ["needs-review"] },
    "labelsRemoved":  { "any": ["blocked"] },
    "assigneesAdded": { "any": ["acme-bot"] },
    "reviewersAdded": { "any": ["acme-reviewer"] }
  },

  "target": {
    "agentRef": { "profile": "product" }
    // or, for either pull request trigger — matches the account being
    // assigned to the item or asked to review it:
    // "agentRef": { "githubLogin": "acme-reviewer-bot" }
  },

  "execution": {
    "prompt": "Review {{ticket.ref}}: {{ticket.title}}\n\n{{ticket.body}}",
    "requireApproval": false,            // uses Hermes' own approval gate
    "modelOverride": null,               // null = the profile's own model
    "timeoutSeconds": 1800,
    "approvalTimeoutSeconds": 3600       // optional; how long a gate may wait
  },

  "outcome": {
    "postComment": { "target": "ticket" },   // ticket | pr | none
    "labels": { "add": ["reviewed"], "remove": ["feasibility"] }
  }
}
```

### The prompt

`execution.prompt` is free text stored on the route — there are no built-in
templates to choose between. Rewording what an agent is asked to do is the main thing
you will want to tune, and that should never require a release.

Placeholders are `{{name}}`:

| | |
|---|---|
| `ticket.ref` `ticket.title` `ticket.body` | the ticket |
| `ticket.url` `ticket.state` `ticket.labels` | `labels` renders as a comma-separated list |
| `project.id` | the project that produced the trigger |
| `agent.profile` `agent.role` | the agent about to run |
| `pr.number` `pr.reviewers` | populated for pull-request triggers |

An unrecognized placeholder is **left in the text verbatim** and logged as a warning,
rather than blanked. A typo like `{{ticket.titel}}` silently becoming an empty string
produces a confidently wrong run; leaving it visible makes the mistake obvious in the
transcript.

Sentinel0 appends its own closing instruction asking for a `SENTINEL0_SUMMARY:` line —
that summary is what lands in the ticket comment and the Slack message. If your prompt
already mentions `SENTINEL0_SUMMARY`, yours is used as written.

```http
GET /v1/route-templates      complete routes for every supported case
GET /v1/prompt-templates     starter prompts and the placeholder list
GET /v1/reserved-labels      the sentinel0:* labels and the default guard
```

These are what a dashboard builds its "new route" flow from. `route-templates` returns
whole routes carrying `<PLACEHOLDER>` tokens for a user to fill in — distinct from the
`{{variables}}` the runner substitutes at dispatch. Every template is verified in CI
against this API's own validator and the prompt renderer, so one that is picked and
filled always produces a route the API accepts.

Nothing dispatches by template id: changing a catalog never alters an existing route.

### Pull request routes

`pr_event` fires for **every open pull request**, every cycle. Use it for anything
keyed on labels, assignees, draft state or base branch.

`pr_review_requested` fires only when someone is awaiting review, and is the one to
use with `target.agentRef.githubLogin` — it matches the agent that was actually
requested, not merely any agent.

A pull request produces both events when it has a requested reviewer, so a route must
pick the trigger type it means.

```jsonc
// "When acme-bot is assigned a PR, have the reviewer agent look at it."
{
  "name": "Review PRs assigned to the bot",
  "trigger": { "type": "pr_event", "provider": "github", "projectId": "www" },
  "match":   { "assignees": { "any": ["acme-bot"] }, "isDraft": false },
  "target":  { "agentRef": { "profile": "reviewer" } },
  "execution": { "prompt": "Review PR #{{pr.number}}: {{ticket.title}}\n\n{{ticket.body}}",
                 "requireApproval": false, "timeoutSeconds": 900 }
}
```

```jsonc
// "When needs-review is ADDED to a PR" — fires on the transition, not on
// every subsequent poll while the label happens to be there.
{
  "name": "Review on label",
  "trigger": { "type": "pr_event", "provider": "github", "projectId": "www" },
  "match":   { "labelsAdded": { "any": ["needs-review"] } },
  "target":  { "agentRef": { "profile": "reviewer" } },
  "execution": { "prompt": "Review PR #{{pr.number}}.", "requireApproval": false,
                 "timeoutSeconds": 900 }
}
```

### A review cycle

Request review → the agent reviews → you reply and re-request → the agent reviews
again. Match on `reviewersAdded`, which fires on the *act* of requesting, not while a
request is outstanding:

```jsonc
{
  "name": "Reviewer agent",
  "guard":   { "refire": "per-change", "markers": true },
  "trigger": { "type": "pr_review_requested", "provider": "github", "projectId": "www" },
  "match":   { "reviewersAdded": { "any": ["acme-reviewer"] } },
  "target":  { "agentRef": { "githubLogin": "acme-reviewer" } },
  "execution": {
    "prompt": "You have been requested as a reviewer on {{ticket.ref}}.\n\nRead it yourself:\n  gh pr view {{pr.number}} --repo {{repo.slug}} --json title,body,comments,reviews\n  gh pr diff {{pr.number}} --repo {{repo.slug}}\n\nIf you reviewed this before, your earlier comments are in that thread. Read the\nauthor's replies and pick up from there rather than repeating findings that have\nalready been addressed.\n\nLeave your review with `gh pr review`.",
    "requireApproval": false,
    "timeoutSeconds": 1800
  }
}
```

`refire: "per-change"` is required — the default `once` would fire one round and stop.
That is safe here because `reviewersAdded` only matches when a reviewer is newly
requested: the agent posting comments, or you pushing commits, adds no reviewer and so
cannot re-summon it.

**Sentinel0 does not fetch the diff or the conversation.** The agent has `gh` and gets
them itself, which is why the prompt tells it to. Inlining that context would put
Sentinel0 back in the business of fetching things the agent can already reach — the same
boundary that keeps git, worktrees and pull requests on the Hermes side.

`{{repo.slug}}` renders as `owner/repo`, so those commands are copy-pasteable.

### Transitions vs. state

`labels` asks *does it have this label now*. `labelsAdded` asks *was it just added*.

Transition clauses need a previous observation, so they **never match the first time
an item is seen**. That is deliberate: without it, creating a route would fire it
across every pull request that already carries the label. A new route starts quiet and
acts on what happens next.

`labelsRemoved` and `assigneesAdded` work the same way.

### Not running twice: the loop guard

An agent acting on a pull request *changes* it — a commit, a review, a comment. If a
route re-fired on every change, it would retrigger itself on its own work. Two
independent mechanisms prevent that.

**`guard.refire`** — `once` (the default) means a route fires for an item exactly
once, whatever happens to it afterwards; the item's revision is excluded from the
dedupe key entirely. `per-change` restores fire-on-every-change and is only safe with
markers on, which the API enforces.

**`guard.markers`** — Sentinel0 writes reserved labels around the run:

| Label | Meaning |
|---|---|
| `sentinel0:in-progress` | a run is working on this right now |
| `sentinel0:done` | a run completed |
| `sentinel0:failed` | a run failed |

Everything Sentinel0 writes is prefixed `sentinel0:`, so machine-managed labels are
obvious in the tracker. They are created automatically if the repo or team does not
have them.

**No route ever matches an item carrying `sentinel0:in-progress`** — unconditionally,
even for a route that turned markers off. Starting a second agent on something already
being worked on is never what you want.

A `once` route also declines anything carrying `sentinel0:done` or `sentinel0:failed`.
**Removing that label by hand is how you re-arm a route** — which is also how you retry
something that failed.

`GET /v1/reserved-labels` returns the list and the default guard.

### Match semantics

- `any` — at least one present (OR)
- `all` — every one present (AND)
- `none` — not one present (NOR)

Omitted keys impose no constraint. An explicitly empty array also imposes none, so a
half-filled rule never accidentally matches everything. An unparseable regex fails
closed: that route matches nothing rather than everything.

### What routes deliberately cannot do

There is no `workspace` field and no `openPullRequest` outcome. Branches, commits, and
pull requests belong to the agent, which does them under its own identity. Outcomes
cover only what Sentinel0 owns: the summary comment — which must land even when the run
*failed*, so it cannot be delegated to the thing that failed — and tracker labels.

### Firing once

Every dispatch is keyed on `(route, trigger ref, trigger revision)`. `revision` is the
ticket's `updatedAt`, so re-observing an unchanged ticket on the next poll does
nothing, while a genuine edit — a new label, a state change — fires the route again.

For `pr_review_requested`, the requested-reviewer set is folded into the revision, so
adding an agent as a reviewer re-fires even when nothing else about the PR changed.

---

### Reading and editing one

```http
GET /v1/routes/{id}
PUT /v1/routes/{id}
```

`PUT` replaces the route entirely rather than merging fields. A route is a
single decision, and its parts constrain each other — a `githubLogin` target is
valid on a pull request trigger and rejected on a ticket one — so a partial
update could walk a route through states the validator rejects as a whole. The
body is validated as the complete rule it will become.

The id in the path wins over any id in the body, so a copy-pasted definition
cannot rewrite a different route. `PUT` to an id that does not exist is a `404`,
not an upsert.

---

## Runs

```http
GET  /v1/runs?status=failed&limit=50
GET  /v1/runs/:id
GET  /v1/runs/:id/events?since=<ms>&limit=500
POST /v1/runs                { "event": { … } }   queue a manual dispatch
POST /v1/runs                { "agentProfile", "prompt" }   run one agent directly
POST /v1/runs/:id/cancel
POST /v1/runs/:id/approval   { "choice": "session" }   answer a waiting agent
POST /v1/resync                                   make the runner reload config
```

`POST` endpoints return `202` with a command id. They queue work for the runner, which
picks it up on its next long poll — usually within a second or two, not on a fixed
interval.

Statuses: `queued`, `running`, `awaiting_approval`, `completed`, `failed`, `canceled`.
`awaiting_approval` still occupies its agent — the run is alive on Hermes and waiting
on a person, not parked.

### Answering an agent that stopped for permission

```http
POST /v1/runs/:id/approval
{ "choice": "once" | "session" | "always" | "deny" }
```

The vocabulary is Hermes' own; anything else is a `400`. `once` allows the single call,
`session` the rest of this run, `always` persists beyond it, `deny` refuses. The
dashboard's **approve** button sends `session`.

A run that is not `awaiting_approval` is a `409` that says what it is doing instead.
Unlike `cancel`, this command is addressed at the runner that mirrored the run — an
approval delivered to any other machine is one nothing will ever answer.

The run's `approval_detail` says what is being asked, where Hermes described it and
otherwise from the last tool call seen on the stream. Nobody answers a gate they cannot
see, so it is a hint, not a contract: every field is optional.

If nobody answers within `execution.approvalTimeoutSeconds` (default 3600), the runner
denies the request and fails the run rather than holding the agent indefinitely. The
run's own `timeoutSeconds` does not advance while it waits — the agent is not working,
so its budget should not burn.

### Starting an agent on your own prompt

`POST /v1/runs` takes two shapes, and exactly one per request. Sending both is a `400`:
they answer different questions, and guessing which was meant would start the wrong
agent on the wrong work.

```http
POST /v1/runs
{
  "agentProfile": "product",
  "prompt": "Audit the billing export and report anything odd.",
  "runnerId": "rnr_…",        // optional; the agent already implies one
  "title": "Billing audit"    // optional; the prompt's first line otherwise
}
```

- `{ "event": … }` synthesises a trigger and puts it through the rule engine, so it
  starts whichever agent a **route** would have started.
- `{ "agentProfile", "prompt" }` starts one named agent on your text, with **no route
  and no trigger**. Nothing is matched, nothing is claimed in the dispatch ledger, and
  no label is moved or comment posted — there is no ticket to move one on.

The agent is resolved against the registry before anything is queued, so an agent that
is unknown (`404`) or disabled (`409`) fails here rather than becoming a command no
runner ever answers. Prompts are capped at 20,000 characters.

The resulting run is an ordinary run: it appears in `GET /v1/runs`, mirrors to Slack,
and can be cancelled. It records `trigger_type: "manual"` and `route_name: "manual
run"`, because there was no route and inventing a plausible id would be worse than
saying so.

One agent still runs at a time. A manual run against a busy agent is **refused** rather
than deferred — nothing will retry it, so the caller is owed the reason.

---

## Agents and runners

```http
GET /v1/agents      Hermes profiles, as discovered by the runner (incl. avatar_url)
GET /v1/runners     registered runners, with health and a `stale` flag
```

Agents are derived state, republished wholesale on every inventory push — a profile
deleted in Hermes disappears here rather than lingering. They are read-only through the
API; the source of truth is Hermes itself.

### Runner health

```json
{
  "name": "cerebro",
  "hostname": "cerebro.local",
  "version": "0.0.1",
  "started_at": "2026-09-01T20:00:00.000Z",
  "last_seen_at": "2026-09-02T08:14:31.000Z",
  "hermes_ok": true,
  "hermes_detail": "hermes-4-70b",
  "active_runs": 1,
  "last_error": null,
  "stale": false
}
```

The runner accepts no inbound connections, so nothing can ask it how it is doing —
health is pushed on every poll cycle, roughly every 25 seconds. `stale` is
`last_seen_at` older than **90 seconds**, which allows three heartbeats to be missed
before anything is reported wrong.

Three states matter, not two. A runner that is checking in but reports
`hermes_ok: false` will never start anything, and calling that healthy would defeat the
point of the indicator. `hermes_ok: null` means the runner is too old to send a
heartbeat — reporting "unreachable" for "did not say" would be worse than saying
nothing.

`last_seen_at` is also refreshed by *any* authenticated runner request, so a runner
predating the heartbeat still reads as alive on the strength of its long poll alone.

> **If every runner reads as stale**, it is running a build from before this existed.
> `last_seen_at` was previously written only by `hello`, which a runner sends once at
> startup — so a runner up for three days reported "last seen 3 days ago", and
> everything older than 90 seconds was stale. Update the runner.

---

## Slack

```http
GET    /v1/integrations/slack
PUT    /v1/integrations/slack   { "webhookUrl": "https://hooks.slack.com/services/…" }
DELETE /v1/integrations/slack
```

`GET` reports *that* a webhook is configured, never what it is.

Events: `run.started`, `run.completed`, `run.failed`, `run.needs_approval`,
`run.canceled`, `runner.stale`. Restrict them by passing `events` to `PUT`.

`run.needs_approval` names what the agent wants to do and how to unblock it. Set
`DASHBOARD_URL` on the API service to have it link straight to the run; without it the
message still gives the `sentinel0 approve <run-id>` command.

`runner.stale` is emitted by a sweep every 45 seconds, once per outage, and cleared by
the runner's next heartbeat. A runner going quiet is the one event that stops everything
else, so it is worth interrupting someone about.

An agent with an `avatarUrl` has its image rendered **inside** the message, as a Block
Kit accessory. The Slack app's own name and icon are never overridden — the webhook's
identity belongs to the app, not to whichever agent happens to be running.

Notifications are sent cloud-side rather than by the runner for one reason worth
knowing: only the cloud can report `runner.stale` when the Mac Mini drops off the
network. Delivery is deduplicated on `(run, event)`, so a retry can never double-post.

---

## Runner endpoints

Documented for completeness. The runner calls these; you should not need to.

```http
POST  /v1/runner/hello                    register; resets started_at
POST  /v1/runner/heartbeat                periodic health, once per poll cycle
PUT   /v1/runner/inventory                publish discovered agents
GET   /v1/runner/projects                 pull ticket sources to watch
GET   /v1/runner/routes                   pull enabled routes
GET   /v1/runner/commands?cursor=&wait=&runner=  long poll, up to 30s
POST  /v1/runner/commands/ack             { cursor, runner }
POST  /v1/runner/runs                     mirror a new run
PATCH /v1/runner/runs/:id                 mirror a status change
POST  /v1/runner/runs/:id/events          mirror log events
```

`GET /v1/runner/commands` is held open until something arrives or the window closes.
An empty array is the normal, healthy result — not an error. This is how a runner
behind NAT receives work without any inbound connection.

Commands are **addressed**. A command carrying a `runner_id` goes only to that runner;
one carrying none is a broadcast and goes to whoever polls. `runner=<name>` is how the
poller says which it is, and the ack carries it for the same reason: acking by cursor
alone would mark another runner's addressed commands delivered before it ever fetched
them. A runner too old to send the parameter receives every broadcast, exactly as
before, and claims nothing addressed to a machine it may not be.

---

## Errors

```json
{ "error": "execution.prompt is required." }
```

| Status | Means |
|---|---|
| 400 | Malformed body; the message names the field |
| 401 | Missing, revoked, or wrong-scope key |
| 404 | Not found in your organization |
| 409 | Out of order — e.g. inventory pushed before `hello` |
