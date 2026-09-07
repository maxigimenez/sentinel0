# The dashboard

`packages/cloud-dashboard` is a React app over the cloud user API. It is where you
watch runs, create routes, and manage projects, keys and Slack — the same things
`GET /v1/*` exposes, without curl.

It is a **pure client**. It holds no server-side session, has no database of its own,
and every request it makes is one an operator could make by hand. Everything it can do
is something a `snt_usr_` key can do.

## Signing in

Sign-in is a user key, pasted once and kept in `localStorage`.

The key is verified against `GET /v1/me` *before* it is stored, so a bad key fails at
the login form with a message rather than being kept and failing on every screen after
it. A stored key is re-verified on each load, because it may have been revoked since
the last visit. Any `401` from any screen ends the session and returns to the login
form — the key is gone, and showing six copies of the same error would be both noisier
and wrong.

> **What this is, and what it is not.** `localStorage` means the key is readable by
> anything with script access to this origin, and it persists until you sign out.
> That is acceptable for v1 because the same key is already sitting in config files on
> operator machines, and the dashboard is not yet multi-user. It is not a substitute
> for real accounts. The upgrade is a server-side session behind an httpOnly cookie,
> and it belongs with the work that introduces users — not before it.

A runner key pasted here is rejected with a `401`, because the API refuses runner scope
on user routes. The login copy names that case, since pasting the wrong one of two
similar-looking keys is the likeliest mistake.

## The API URL

The dashboard reads its API URL **at runtime**, from `SENTINEL0_API_URL`.

`server.mjs` generates `/env.js` per request, and the page loads it before the bundle:

```js
window.__SENTINEL0__ = { apiUrl: 'https://api-production-xxxx.up.railway.app' }
```

A `VITE_` variable would have been inlined by the bundler, which would mean rebuilding
and redeploying the image every time the control plane moved. This way it is a Railway
variable and a restart.

`GET /health` on the dashboard reports whether one is set:

```json
{ "status": "ok", "apiConfigured": true }
```

It reports `apiConfigured: false` rather than failing, because a container that cannot
serve its own pages is the outage worth restarting for; a missing API URL is fixed by
editing a variable. The deploy workflow turns that into a warning, and the login screen
says so in place.

The API must allow the dashboard's origin. `CORS_ORIGINS` on the cloud-api service is
a comma-separated allowlist, and unset means all.

## Local development

```bash
pnpm install
SENTINEL0_API_URL=http://127.0.0.1:8080 pnpm --filter @sentinel0/cloud-dashboard dev
```

Vite serves `/env.js` itself in dev, from the same variable, so dev and production
resolve the URL through one code path rather than two that can disagree.

To run the whole stack locally, with the control plane against a throwaway Postgres:

```bash
docker run -d --name sentinel0-pg -e POSTGRES_PASSWORD=sentinel0 \
  -e POSTGRES_DB=sentinel0 -p 55433:5432 postgres:16

export DATABASE_URL="postgres://postgres:sentinel0@127.0.0.1:55433/sentinel0"
export DATABASE_SSL=disable

pnpm --filter @sentinel0/cloud-api build
node packages/cloud-api/dist/migrate-cli.js
node packages/cloud-api/dist/org-cli.js --name "Your Company"   # prints both keys

PORT=8080 node packages/cloud-api/dist/index.js
```

Then sign in with the `snt_usr_` key it printed.

To exercise the production server rather than Vite's:

```bash
pnpm --filter @sentinel0/cloud-dashboard build
PORT=8081 SENTINEL0_API_URL=http://127.0.0.1:8080 \
  node packages/cloud-dashboard/server.mjs
```

## Deploying

The dashboard is a **second Railway service**, alongside `api`.

### One-time setup

1. Create a service named `dashboard` in the same Railway project.
2. Apply the project configuration, which tells that service to build
   `Dockerfile.dashboard` rather than the control plane's:

   ```bash
   pnpm railway:plan      # preview; changes nothing
   pnpm railway:apply
   ```

   This step is load-bearing. A service with no configuration of its own falls back
   to Railway's own detection, and previously to a root `railway.json` — which is how
   a dashboard service ends up building and deploying the *API* image, starting
   cleanly, and passing its health check while serving the wrong thing.
3. Under **Variables**, set `SENTINEL0_API_URL` to the API service's public URL.
4. Generate a domain for the service.
5. On the **api** service, add the dashboard's origin to `CORS_ORIGINS` if you have
   narrowed it from the default.

### Deploying

Actions → **Deploy dashboard** → *Run workflow*, which lets you pick the branch.
Deploys are manual: merging and shipping are separate decisions, and there is no push
trigger.

By hand:

```bash
pnpm railway:deploy:dashboard
```

The image is built from `Dockerfile.dashboard` at the repo root, with the root as
build context because this is a pnpm workspace.

> **`railway up` deploys source; it does not reconcile configuration.** After changing
> `.railway/railway.ts`, run `pnpm railway:apply` — otherwise the service keeps
> building whatever it was last told to.

## Why a server at all

The runtime image is a static bundle plus one script and **no `node_modules`** —
`server.mjs` is deliberately dependency-free. It exists for three things a bucket
cannot do:

- **`/env.js`**, so the API URL is a variable rather than a rebuild.
- **SPA fallback.** A request matching no file serves `index.html`, so `/runs/run_1`
  survives a reload or a shared link.
- **`/health`**, for Railway's check.

It also gets the caching right in the one way that matters: hashed assets under
`/assets/` are immutable for a year, and `index.html` never is — cache that and a
deploy reaches nobody still holding the previous one.

## Creating and editing

Every screen that creates something does it on **its own page**, reached from a button
in the top right of the list: `/routes/new`, `/projects/new`, `/keys/new`. Routes can
also be edited, at `/routes/:id/edit`.

The button is why the action slot in the page header is always rendered, even empty. A
slot that appears only on pages with a button shifts the header — and everything under
it — by a button's height as you move between sections.

### Running an agent directly

The runs screen carries a **run agent** button, which opens a dialog: a runner, an
agent on that runner, and a prompt. It starts that agent on that text — no route, no
ticket, no trigger.

This exists because routes answer "when something happens, do this" and a one-off
question does not need a rule that outlives it. Creating a throwaway route to ask one,
then remembering to delete it, is how a route table fills with entries nobody dares
turn off.

The agent list is filtered to enabled agents **on the selected runner**, because a
profile lives on exactly one machine; offering the whole pool would let someone address
a command to a runner that has never heard of it. A stale runner is offered but named
as stale, and the dialog says the command will wait — hiding it would present "no
runners" for what is really "the runner stopped checking in".

The run does not exist until the runner picks the command up, so the confirmation says
so rather than leaving someone watching an unchanged list. It then appears like any
other run, with `manual run` in its Route column.

### The route form

Creating starts from a template, because the combinations that actually fire are a
small subset of what the schema permits, and the catalog is that subset. The form then
asks only for what the template declares, and asks for it with the right control:

| Template placeholder | Control |
|---|---|
| `<PROJECT_ID>` | a dropdown of registered projects |
| `<AGENT_PROFILE>` | a dropdown of discovered agents |
| `<AGENT_GITHUB_LOGIN>` | filled from the selected agent |
| anything else | a text field |

Free text where the API already knows the answer produces a route that is structurally
valid and can never match — a typo'd project id fires nothing, silently, forever.
Selecting the agent is also what fills a `githubLogin` target, so the two cannot drift
apart the way two independent fields would.

Under the prompt is the list of variables the runner substitutes at dispatch. Clicking
one inserts it at the cursor. This matters more than it looks: the runner deliberately
leaves an unrecognised `{{placeholder}}` visible rather than blanking it, so a typo
cannot become a confidently wrong run — but that only helps if the writer knows which
names are real.

### What editing changes, and what it keeps

The form owns name, project, agent, priority, enabled, timeout and prompt. Everything
else — the match clauses, the guard that stops a route re-firing on the agent's own
work, the outcome — is written back untouched, and shown read-only under *show
definition* so it is not a surprise.

That separation is the point. Renaming a route must never quietly drop its loop guard,
and a form that rebuilt the rule from its own fields would do exactly that.

`PUT /v1/routes/:id` replaces the whole rule and revalidates it, so a route can never
be saved into a state the runner would reject.

## What it does not do

- **No agent management.** Agents are Hermes profiles discovered on the runner's
  machine, not records anyone creates here. The next inventory push would overwrite
  anything the dashboard wrote.
- **No members, roles or billing.** There is no users table. An organization is a row
  and a set of keys; anyone holding a `snt_usr_` key has the same access.
- **No renaming an organization.** Its name is set by `org-cli.js` at creation and
  there is no endpoint to change it.

## The organization rail

Organization pages — Settings, Integrations, Projects, Access keys, Runners — render
behind a second-level nav between the sidebar and the page. It is the design's
`showOrgRail`, and it exists because that group had outgrown a flat list: five
destinations, each a settings surface rather than a view of work, would have buried
Runs and Routes among them in the primary sidebar.

`components/OrgRail.tsx` owns both the entries and `isOrgPath`, which `AppShell` uses
to mount it. Each entry carries a hint under its label, because these pages are
visited rarely enough that "Settings" and "Projects" do not by themselves say which
one holds the thing you came for.

Adding a page to the group means adding one entry to `ORG_RAIL` and one `<Route>`;
the rail's visibility follows from the entry rather than from a second list that
could disagree with it.

The old Settings screen carried the organization, Slack, **and** the runner table.
Slack moved to Integrations, beside the tracker credentials it belongs with, and the
runners to a page of their own — it was the only table on a page of forms, and "is
the Mac Mini still there" is asked far more often than anything else that page held.

## Design system

The UI is built on [`@16-bits-design/ui`](https://github.com/maxigimenez/16-bits-design),
which is the component library for this visual language — square geometry, 2px borders,
offset shadows, JetBrains Mono body and Silkscreen display type.

Application code uses `--bits-*` semantic variables and never hardcodes a colour, so
the whole dashboard follows the theme. `src/styles.css` holds layout only: the shell,
the sidebar, the run dialog, and the few surfaces the library does not ship.

At `@16-bits-design/ui` 0.1.0 that file also carried local implementations of an
alert, an empty state, a loading indicator, a segmented filter, a code block and a
table, each filed upstream as an issue. **The library's 0.2.0 shipped all six**, and
they are now imported rather than reimplemented:

| Was | Now |
|---|---|
| `components/Alert.tsx` | `@16-bits-design/ui/alert` |
| `components/EmptyState.tsx` | `@16-bits-design/ui/empty-state` |
| `components/Loading.tsx` | `@16-bits-design/ui/spinner` |
| `components/Segmented.tsx` | `@16-bits-design/ui/segmented` |
| `components/CodeBlock.tsx` | `@16-bits-design/ui/code` |
| `.px-table` markup | `@16-bits-design/ui/table` |

Two behavioural notes from that swap, because both are easy to undo by accident:

- The library's `Table` draws its own frame. Inside a panel that is the second border
  on the same edge, so `.px-tablewrap` removes it. The class is now only a modifier on
  the library's scroll container, not a container of ours.
- Block `Code` **renders** its label rather than only announcing it. In a page section
  that is useful; in a table cell it duplicates the row, so those labels are short.

### The noir theme

The dashboard runs on a **custom theme**, not a built-in one. `ThemeProvider` takes any
name and writes it to `data-bits-theme`; `src/theme-noir.css` defines what `noir`
means. It is loaded after the library stylesheet, which is what lets its palette win.

Noir is neutral where the `nebula` it replaced was purple: the surfaces carry no hue at
all, and the violet appears only where something is interactive. That is what leaves the
red core of the sentinel0 mark, and a failed run, as the two things on screen with any
warmth in them.

Only colour is redefined. Geometry, type and spacing come from the library's `:root`,
because those are the visual language rather than the palette. The text ramp is
calibrated against ember's — each step within a few tenths of the corresponding
contrast against `--bits-panel` — rather than picked by eye.

`--bits-ink` is set explicitly, which the built-in `ocean` does not do: ink is the
foreground on a primary fill, and inheriting ember's warm brown onto a violet badge is
exactly the kind of silent failure a custom theme invites. `test/theme.test.ts` pins
that, and that the theme covers every colour a built-in theme defines — a token a theme
forgets is not an error, it simply inherits ember, and you find out when one hover
state renders orange.

The mark in the sidebar is drawn by `components/BrandMark.tsx` for the same reason: the
brand file carries its own fixed palette, and an `<img>` cannot read a custom property
whatever the SVG says. `public/brand/sentinel0-icon.svg` stays for the favicon, which is
outside the document either way.

### Element defaults, and the test that used to guard them

The library styles bare elements — `a`, `h1`–`h6`, `p`, `code` — as defaults wrapped in
`:where()`, so they contribute no specificity and a single application class overrides
them.

That was not always true. At the library's 0.1.0 those rules were `.bits-theme a` at
specificity (0,1,1), which silently out-specified a one-class app rule: every breadcrumb
and idle sidebar link rendered primary orange instead of muted grey, and every heading
rendered as 24px display type. It survived review because the result looks deliberate —
an all-orange nav reads as a styling choice until you hold it next to the design.

The workaround was to double every affected selector under `.px-root`. The library
fixed it at the source, so the doubling is gone and `test/specificity.test.ts` is
inverted: it no longer checks that the app doubles up its selectors, it checks that the
library still makes doubling unnecessary. A regression would be as invisible as the
original bug.

`.px-root` itself remains, for the reason it was always also needed: `ThemeProvider`
renders a real `div` between `#root` and the app, and that element needs a height.
`.px-shell` is anchored to `100dvh` rather than a percentage — a height inherited
through flex-grow is used but not *definite*, so percentage heights below it fall back
to auto and every column collapses to its content.

### Still local

`components/RunPromptDialog.tsx` is the one component built here rather than imported.
The library's `Dialog` is a confirmation: it renders its `description` inside a `<p>`,
where a browser reparents any form control, and its focus trap looks only for buttons,
links and inputs — not a `select` or a `textarea`. Both are right for "are you sure"
and neither works for a form. Filed upstream as
[maxigimenez/16-bits-design#21](https://github.com/maxigimenez/16-bits-design/issues/21);
it is a candidate to delete when a composable dialog lands, and its CSS deliberately reuses the library's own dialog
geometry so the two read as the same component.
