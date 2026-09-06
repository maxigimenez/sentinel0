# Routes

A route says: **when this happens, start that agent, then do this with the result.**

Routes are data, stored in the cloud. A new workflow is a row, not a release.

```jsonc
{
  "name": "Assess on label",
  "priority": 100,
  "enabled": true,
  "guard":     { "refire": "once", "markers": true },
  "trigger":   { "type": "ticket", "projectId": "taplands" },
  "match":     { "labels": { "any": ["feasibility"] } },
  "target":    { "agentRef": { "profile": "product" } },
  "execution": { "prompt": "Assess {{ticket.ref}}…", "requireApproval": false,
                 "timeoutSeconds": 1800 },
  "outcome":   { "postComment": { "target": "ticket" } }
}
```

Highest `priority` wins; ties break on id. Only one route fires per event.

**Start from a template.** `GET /v1/route-templates` returns complete, ready-to-create
routes for every case below, each with `<PLACEHOLDER>` tokens to fill in. Every one is
checked in CI against the API's own validator and the prompt renderer, so a template
you pick and fill always produces a route the API accepts.

---

## Triggers

| `trigger.type` | Fires on | Notes |
|---|---|---|
| `ticket` | Every ticket matching the project's filters | Linear or GitHub issues |
| `pr_event` | Every open pull request, every cycle | The general-purpose PR trigger |
| `pr_review_requested` | Open PRs with at least one requested reviewer | Use with `target.agentRef.githubLogin` |
| `manual` | `POST /v1/runs` from the API | Queued for the runner's next poll |

A pull request with a pending review request produces **both** `pr_event` and
`pr_review_requested`, so a route must pick the one it means.

`trigger.provider` is optional. Omit it to match either provider; pin it when a project
id could exist under both.

---

## Matching

Every clause must hold. Set clauses take `any` (OR), `all` (AND) and `none` (NOR);
omitting a key, or giving it an empty array, imposes no constraint.

### On current state

| Clause | Applies to |
|---|---|
| `labels` | anything |
| `state` | tickets (`Backlog`, `open`, …) |
| `assignees` | anything |
| `reviewers` | pull requests — who is currently asked to review |
| `titleMatches` / `bodyMatches` | regex against title or description |
| `isDraft` | pull requests only |
| `baseBranch` | pull requests only |

### On what changed

| Clause | Fires when |
|---|---|
| `labelsAdded` | a label was just added |
| `labelsRemoved` | a label was just removed |
| `assigneesAdded` | someone was just assigned |
| `reviewersAdded` | someone was just asked to review |

**Transitions never match the first time an item is seen.** With no prior observation
every label would look newly added, and creating a route would fire it across your
entire backlog. A new route starts quiet and acts on what happens next — so to test
one, add and remove the label once while the runner is up.

`labels` asks *does it have this now*. `labelsAdded` asks *was it just added*. Pick the
second when the act is the signal.

### Targeting an agent

```jsonc
"target": { "agentRef": { "profile": "product" } }          // by Hermes profile
"target": { "agentRef": { "githubLogin": "acme-reviewer" } } // by GitHub identity
```

`githubLogin` fires only when that account is **named on the item** — assigned to it,
or asked to review it — which is what makes "act when *this* agent is asked" address
one agent rather than all of them. It applies to pull request triggers only; the API
rejects it on a `ticket` route, which could never fire.

### Which GitHub account is which

There are two, and Sentinel0 only owns one of them.

- **The runner's `gh`.** Every poll, every label, every comment Sentinel0 writes goes
  through whatever `gh auth login` was run on the runner's machine. This account needs
  write access to the repositories you watch, or the `sentinel0:in-progress` marker
  cannot be set and routes will fire twice.
- **The agent's own `gh`,** inside its Hermes profile. This is who opens the pull
  request and leaves the review. Sentinel0 passes Hermes **no** GitHub token — the
  agent's credentials are Hermes' business entirely.

`githubLogin` in `~/.sentinel0/config.json` is your *declaration* of which account the
second one is. Nothing verifies it. Set it wrong and login-targeted routes silently
never match; leave it unset and `sentinel0 preflight` says so. It cannot be set from
the dashboard, because the agent registry there is derived state — the next inventory
push would overwrite it.

---

## Not running twice

An agent acting on a pull request *changes* it — a commit, a review, a comment. A route
that re-fired on every change would retrigger itself on its own work. Two independent
mechanisms prevent that.

### `guard.refire`

- **`once`** (default) — fires for an item exactly once, whatever happens afterwards.
  The item's revision is dropped from the dedupe key entirely, so this holds even
  where labels cannot be written.
- **`per-change`** — fires again each time the item changes. Required for anything
  with rounds, and only accepted with `markers` on.

### `guard.markers`

Sentinel0 writes reserved labels around each run:

| Label | Meaning |
|---|---|
| `sentinel0:in-progress` | a run is working on this now |
| `sentinel0:done` | a run completed |
| `sentinel0:failed` | a run failed |

Everything Sentinel0 writes is `sentinel0:`-prefixed, so machine-managed labels are
obvious. They are created automatically if the repository or team lacks them.

**No route ever matches an item carrying `sentinel0:in-progress`** — unconditionally,
even for a route with markers off. Starting a second agent on in-flight work is never
wanted.

A `once` route also declines anything carrying `sentinel0:done` or `sentinel0:failed`.
**Removing that label by hand re-arms the route**, which is also how you retry
something that failed.

### Choosing

| You want | `refire` | Why |
|---|---|---|
| act on a ticket, once | `once` | the default; cannot loop |
| review every time you are asked | `per-change` + `reviewersAdded` | only a request re-fires it |
| act on each label change | `per-change` + `labelsAdded` | only labelling re-fires it |

The pattern for `per-change`: pair it with a **transition** clause. Then only the human
act re-fires the route, and nothing the agent does can.

---

## The prompt

`execution.prompt` is free text with `{{placeholders}}`. There is no template to
choose — rewording what an agent is asked to do should never need a release.

| | |
|---|---|
| `{{ticket.ref}}` `{{ticket.title}}` `{{ticket.body}}` | the item |
| `{{ticket.url}}` `{{ticket.state}}` `{{ticket.labels}}` `{{ticket.assignees}}` | |
| `{{project.id}}` `{{repo.slug}}` | `repo.slug` renders `owner/repo` |
| `{{agent.profile}}` `{{agent.role}}` | the agent about to run |
| `{{pr.number}}` `{{pr.reviewers}}` `{{pr.baseBranch}}` | pull requests |
| `{{changes.labelsAdded}}` `{{changes.labelsRemoved}}` `{{changes.assigneesAdded}}` `{{changes.reviewersAdded}}` | what just changed |

An unrecognized placeholder is **left visible** in the prompt and logged as a warning,
never blanked — a typo silently becoming an empty string produces a confidently wrong
run.

Sentinel0 appends an instruction asking for a `SENTINEL0_SUMMARY:` line, which is what
lands in the ticket comment and the Slack message. If your prompt already mentions
`SENTINEL0_SUMMARY`, yours is used as written.

`GET /v1/prompt-templates` returns starter prompts and this variable list.

### Let the agent fetch its own context

Sentinel0 does not inline diffs or comment threads. The agent has `gh` and its own
credentials — tell it what to read:

```
Read it yourself:
  gh pr view {{pr.number}} --repo {{repo.slug}} --json title,body,comments,reviews
  gh pr diff {{pr.number}} --repo {{repo.slug}}
```

This is the same boundary that keeps git, worktrees and pull requests on the Hermes
side: Sentinel0 decides *when, which agent, and with what context*; the agent does the
work with the tools it already has.

---

## Outcomes

What Sentinel0 does after the run:

```jsonc
"outcome": {
  "postComment": { "target": "ticket" },              // ticket | pr | none
  "labels": { "add": ["reviewed"], "remove": ["queued"] }
}
```

`postComment` posts the agent's summary — **and posts on failure too**, which is why it
belongs to Sentinel0 rather than the agent: a run that failed cannot report on its own
behalf.

There is no `openPullRequest` outcome. Branches, commits and pull requests belong to
the agent, under its own identity.

Slack notification is org-level, not per route, so every agent action is visible
without opting in each time. See [api.md](./api.md#slack).

---

## The supported cases

Each is available complete from `GET /v1/route-templates`.

### Assess a ticket when it gets a label
`ticket` · `labels` · `once`. The agent reads the ticket and comments back. Writes no
code, so it needs nothing configured on the repository — the safest route to start
with.

### Triage the moment a label is added
`ticket` · `labelsAdded` · `once`. Same, but on the act of labelling, so creating the
route does not sweep your backlog.

### Implement a ticket
`ticket` · `labels` · `once`. The agent owns branch, edits, checks, commit, push and
pull request under its own identity. Its Hermes profile needs a working directory and
git credentials for the repository.

### Review a pull request, every time you are asked
`pr_review_requested` · `reviewersAdded` · `per-change`. Request review → the agent
reviews → you reply and re-request → it reads the thread and reviews again. Pushing
commits or replying does not re-summon it; only a fresh request does.

### Act on a pull request assigned to an agent
`pr_event` · `assigneesAdded` + `isDraft: false` · `per-change`. Assignment rather than
review request is the signal.

### Act on a pull request when a label is added
`pr_event` · `labelsAdded` · `per-change`. Pair with an outcome that removes the label
to make the label itself a queue.

### Pick a pull request back up when it is unblocked
`pr_event` · `labelsRemoved` · `per-change`. The other half of a human gate: label to
pause, unlabel to resume.

---

## Troubleshooting

**Nothing fired.** Watch one poll cycle — the runner prints a summary line:

```
poll: 12 event(s) (taplands 12) · dispatched 1 · skipped 11 (no-route 10, duplicate 1)
```

`0 event(s)` means the item was never fetched: no projects (`sentinel0 projects`), or
the project's `filters` excluded it. `no-route` means it was fetched and nothing
matched. `unknown-agent` means the route names a profile absent from `sentinel0 agents`.

**It fired once and never again.** That is `refire: "once"`. The item now carries
`sentinel0:done` — remove it to re-arm, or switch to `per-change` with a transition
clause.

**A transition route never fires.** It needs a prior observation. Add and remove the
label once while the runner is up.

**Everything fired at once when I created a route.** A state clause (`labels`) matches
everything currently carrying the label. Use `labelsAdded` if you meant the act.
