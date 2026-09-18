<p align="center">
  <img src="https://raw.githubusercontent.com/maxigimenez/sentinel0/main/.github/banner.png" alt="sentinel0" width="760">
</p>

Trigger your [Hermes](https://hermes-agent.nousresearch.com) agents from your tickets and
pull requests.

> **Alpha.** Expect rough edges and occasional breaking changes.

You already run a fleet of Hermes profiles — a product reviewer, a code reviewer, an
implementer, each with its own memory, model, and GitHub account. sentinel0 is the layer
that decides **which one should start, when, and with what context**, then records what
happened and tells your team about it.

**It never runs an agent itself and never touches a repository.** It decides; Hermes does
the work. The runner needs no clone of your code — only API access to your tracker and
HTTP access to Hermes on the same machine. It makes outbound connections only, so it
works behind NAT with no tunnel and no port forwarding.

## Install

```bash
npm install -g sentinel0
```

## Quick start

On the machine that runs Hermes:

```bash
sentinel0 init          # cloud key, Hermes profiles — each key is probed as you enter it
sentinel0 preflight     # Node, Hermes, cloud, tracker credentials
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
```

Debugging a machine rather than a workflow:

```bash
sentinel0 run --agent product --prompt "Reply with the word ready."
```

`sentinel0 help` lists every command.

## Routes are data

A route says which trigger starts which agent, with what prompt, and what to do with the
result. A new workflow is a row, not a release — and because the prompt lives on the
route, rewording what an agent is asked to do never needs one either.

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

Ready-made routes for every supported case, including multi-round pull request review,
ship with the control plane and are served from `GET /v1/route-templates`.

For assigned implementation, `init` accepts a profile's GitHub login or its Linear
user and workspace IDs; `agents` shows those declarations. Linear projects also need
an implementation repository. See the
[assignment setup](https://github.com/maxigimenez/sentinel0/blob/main/docs/routes.md#implement-an-assigned-issue)
for route templates, initial-run behavior, and release limitations.

## State

Everything this CLI keeps lives under `~/.sentinel0` — cloud credentials and Hermes keys
in `config.json`, the last known good routes in `routes.json`, run history in
`sentinel0.db`, and the runner's logs. `SENTINEL0_DATA_DIR` moves it.

## Requirements

- **Hermes Agent** with its API server enabled and `gateway.multiplex_profiles` on, and a
  distinct `API_SERVER_KEY` per profile
- **Node.js >= 22.5** — the CLI re-executes itself under a compatible interpreter if the
  active one cannot load `node:sqlite`
- A **sentinel0 control plane** to point at, and a `snt_usr_` key for it
- A GitHub integration token if any project pulls from GitHub. Hermes profiles need
  their own repository credentials to open PRs; Sentinel0 does not pass its token on.

## Documentation

Full docs, including the control plane, the dashboard and every route option, are in the
repository: **[github.com/maxigimenez/sentinel0](https://github.com/maxigimenez/sentinel0)**

## Feedback

Bugs, rough edges and unclear docs are all worth an issue:
**[github.com/maxigimenez/sentinel0/issues](https://github.com/maxigimenez/sentinel0/issues)**
