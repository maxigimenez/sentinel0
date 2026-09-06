<p align="center">
  <img src=".github/banner.svg" alt="sentinel0" width="760">
</p>

Trigger your [Hermes](https://hermes-agent.nousresearch.com) agents from your tickets
and pull requests.

You already run a fleet of Hermes profiles — a product reviewer, a code reviewer, an
implementer, each with its own memory, model, and GitHub account. Sentinel0 is the layer
that decides **which one should start, when, and with what context**, then records what
happened and tells your team about it.

```jsonc
// "When a Linear ticket gets the feasibility label,
//  have the product agent assess it and comment back."
{
  "name": "Product review on feasibility label",
  "trigger": { "type": "ticket", "provider": "linear", "projectId": "taplands" },
  "match":   { "labels": { "any": ["feasibility"] } },
  "target":  { "agentRef": { "profile": "product" } },
  "execution": { "prompt": "Assess {{ticket.ref}}: {{ticket.title}}\n\n{{ticket.body}}",
                 "timeoutSeconds": 1800 },
  "outcome": {
    "postComment": { "target": "ticket" },
    "labels": { "add": ["reviewed"], "remove": ["feasibility"] }
  }
}
```

That is the whole idea. Routes are data, so a new workflow is a row, not a code change
— and the prompt lives on the route, so rewording what an agent is asked to do never
needs a release.

Ready-made routes for every supported case, including multi-round pull request review,
are in **[docs/routes.md](./docs/routes.md)** and served from `GET /v1/route-templates`.

## How it fits together

```
Mac Mini                                    Railway
┌──────────────────────────────┐      ┌──────────────────────┐
│ Hermes gateway               │      │ api                  │
│   :8642  /p/<profile>/v1/…   │      │   config · registry  │
│   owns git, PRs, identity    │      │   run history        │
│            ▲                 │      │   Slack              │
│            │ POST /v1/runs   │      │          ▲           │
│ sentinel0 runner              │─────►│          │           │
│   triggers → routes →        │ long │  ┌───────┴────────┐  │
│   dispatch → outcomes        │ poll │  │ dashboard      │  │
└──────────────────────────────┘      │  └────────────────┘  │
                                      └──────────────────────┘
```

**Sentinel0 never runs an agent itself and never touches a repository.** It decides;
Hermes does the work. The runner needs no clone of your code — only API access to your
tracker and HTTP access to Hermes on the same machine.

The runner only makes outbound connections, so the Mac Mini works behind NAT with no
tunnel and no port forwarding.

## The dashboard

A web UI for the same thing: watch runs, create routes from templates, manage projects,
keys and Slack. Sign in with a `snt_usr_` key. It deploys to Railway as a second
service alongside the API.

Full detail: **[docs/dashboard.md](./docs/dashboard.md)**

## Getting started

Full walkthrough: **[docs/getting-started.md](./docs/getting-started.md)**

```bash
# On the Mac Mini, next to Hermes
npm install -g sentinel0

sentinel0 init          # cloud key, Hermes profiles — each key is probed as you enter it
sentinel0 preflight     # Node, Hermes, cloud, gh auth
sentinel0 start
sentinel0 runner install  # survive reboots (launchd)
```

Then:

```bash
sentinel0 agents               # profiles it discovered, with models and toolsets
sentinel0 routes               # what it will act on
sentinel0 runs                 # recent runs
sentinel0 logs --follow        # watch one happen
sentinel0 cancel <id>          # stop it here and on Hermes
sentinel0 approve <id>         # answer an agent waiting for permission
```

Debugging a machine, not a workflow:

```bash
sentinel0 run --agent product --prompt "Reply with the word ready."
```

## Documentation

| | |
|---|---|
| [Getting started](./docs/getting-started.md) | Hermes setup, deploy, keys, first route |
| [Routes](./docs/routes.md) | Every supported trigger, match, guard and outcome |
| [Cloud API](./docs/api.md) | Orgs, keys, projects, routes, runs, Slack |
| [Deploying to Railway](./docs/deploy-cloud.md) | Docker build, migrations, env vars |
| [CI and releasing](./docs/releasing.md) | The three workflows, secrets, publishing |
| [CLAUDE.md](./CLAUDE.md) | Architecture, for contributors |

## Requirements

- **Hermes Agent** with its API server enabled and `gateway.multiplex_profiles` on,
  and a distinct `API_SERVER_KEY` per profile
- **Node.js >= 22.5** — the CLI re-executes itself under a compatible interpreter if
  the active one cannot load `node:sqlite`
- **Postgres**, for the control plane
- `gh`, authenticated, if any project pulls from GitHub

## Repository layout

```
packages/
  common/         shared types — run status, routing rules, config
  orchestrator/   the runner: triggers, routes, dispatch, outcomes
  cli/            the published sentinel0 package
  cloud-api/      Railway control plane (Fastify + Postgres)
```

```bash
pnpm install
pnpm build
pnpm test
```
