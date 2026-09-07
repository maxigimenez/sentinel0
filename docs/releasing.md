# CI and releasing

Four workflows. One runs on every change; three ship things.

| Workflow | Trigger | What it does |
|---|---|---|
| [`ci.yml`](../.github/workflows/ci.yml) | PRs, pushes to `main` | Lint, typecheck, test on Node 22 and 24 |
| [`deploy-cloud-api.yml`](../.github/workflows/deploy-cloud-api.yml) | Manual only | Deploys to Railway and waits for `/health` |
| [`deploy-dashboard.yml`](../.github/workflows/deploy-dashboard.yml) | Manual only | Deploys to Railway and waits for `/health` |
| [`publish-cli.yml`](../.github/workflows/publish-cli.yml) | Manual, or a published GitHub release | Verifies, packs, and publishes `sentinel0` to npm |

---

## CI

Runs the whole suite on **Node 22.12 and Node 24**. That matrix is not decoration: 22
needs `--experimental-sqlite` for `node:sqlite` and 24 ignores it, so running both is
what keeps the supported range honest rather than aspirational. `NODE_OPTIONS` carries
the flag for the whole job.

It is the *tests* that need both. Lint and typecheck read no runtime API and pin their
own `@types/node`, so their result cannot differ between the two, and they run on the
row marked `primary: true` alone. The flag lives on the matrix row rather than being
matched against `'24.x'`, so bumping the newest Node in that list cannot quietly leave
the repo unlinted.

The floor is 22.12 rather than 22.11 because Vite 8, which builds the dashboard,
declares `^20.19.0 || >=22.12.0`. Vite is a build tool and ships in nothing, so this
constrains where the repo can be *built*, not where the runner can run.

It builds **before** typechecking and testing, and the order matters twice over.
`cloud-api` resolves `@sentinel0/common` through its built `.d.ts` rather than a path
alias, so a typecheck against a clean tree cannot see it at all. And one suite imports
the built package rather than the source — every other test aliases
`@sentinel0/common` to `src/`, which resolves module cycles differently from the real
ESM graph. A circular import once passed the entire suite and only failed when the
container started.

### What CI does not do

It does not build the Docker images, and it does not validate the workflow files.

Both jobs existed and were removed, for the same reason. `railway up` uploads source
and Railway does the build, so the image jobs never produced an artifact anything
consumed — they ran a minute apiece on every pull request to fail early on a
`Dockerfile` that most pull requests do not touch. The workflow parser cost four
minutes, almost all of it `npm install` resolving a pnpm workspace root, and checked
only that the YAML parses and has `on:` and `jobs:`.

The exposure that leaves is real but narrow. A broken `Dockerfile` now surfaces during
a deploy rather than on the pull request, so **build the image locally before deploying
a change to either one**:

```bash
docker build --platform linux/amd64 -f Dockerfile .              # cloud-api
docker build --platform linux/amd64 -f Dockerfile.dashboard .    # dashboard
```

`linux/amd64` is the architecture Railway deploys on; an image that builds there builds
in the deploy. An invalid workflow file still shows up the way GitHub shows it — a run
with no jobs and an error in no job log — which is confusing, and was the reason for
the parser, but not four minutes a pull request's worth of reason.

---

## Deploying cloud-api

### One-time setup

1. In Railway: **Project Settings → Tokens → New Token**. A *project* token is enough
   and does not need linking.
2. In GitHub: **Settings → Secrets and variables → Actions**, add `RAILWAY_TOKEN`.
3. Optionally add a repository *variable* `CLOUD_HEALTH_URL` (e.g.
   `https://api-production-xxxx.up.railway.app`). The workflow otherwise scrapes the
   domain from the Railway CLI, whose output has changed shape between versions.

### Deploying

**Deploys are manual.** From the Actions tab — *Deploy cloud-api → Run workflow*.
GitHub's **"Use workflow from"** dropdown picks the branch, and the deploy uses that
checkout, so you can ship a branch before it merges. The service name defaults to
`api`.

> **The Run workflow button only appears once the workflow is on your default branch.**
> GitHub reads `workflow_dispatch` from `main` regardless of which branch you want to
> run. Until this merges, deploy by hand with `pnpm railway:deploy:api` from the repo
> root.

There is deliberately no push trigger. Merging and shipping are different decisions:
redeploying the control plane interrupts every runner's long poll, and a merge does not
mean "this is ready to go live". Coupling them also meant every merge produced a failed
deployment on the repository's Environments page.

The workflow deploys straight from the checkout, so no git remote needs connecting on
the Railway side, and the repo root is the Docker build context.

Deploys are serialized (`concurrency` without cancellation) because the pre-deploy step
runs migrations, and two concurrent migration runs against one database is a way to
lose an afternoon.

### After a deploy

The runner reloads projects and routes on its own each cycle, so nothing needs
restarting on the Mac Mini — *unless* the deploy added an endpoint the runner needs,
in which case the runner has to be updated too. Its fallback is deliberately quiet:

```bash
grep "Could not fetch" ~/.sentinel0/runner.stdout.log
```

---

## Deploying the dashboard

The dashboard is a **second Railway service**, and the one thing that must be right is
its config file.

### One-time setup

1. Create a service named `dashboard` in the same project.
2. Apply the project configuration, so the service builds `Dockerfile.dashboard`
   rather than the control plane's:

   ```bash
   pnpm railway:plan && pnpm railway:apply
   ```

   Skip it and the service falls back to Railway's own detection — which is how a
   dashboard service ends up deploying the API image, starting cleanly, and passing
   its health check while serving the wrong thing.
3. **Variables**: `SENTINEL0_API_URL`, pointing at the API service's public URL. It is
   read at runtime, so changing it later is a restart rather than a rebuild.
4. Generate a domain.
5. Optionally add a repository *variable* `DASHBOARD_HEALTH_URL`, for the same reason
   the API has one: `railway domain` output has changed shape between CLI versions.

Full detail, including the local stack, is in [dashboard.md](./dashboard.md).

### Deploying

Actions → *Deploy dashboard → Run workflow*, picking the branch. Manual only, for the
same reason as the control plane. By hand: `pnpm railway:deploy:dashboard`.

`railway up` deploys source and does not reconcile configuration, so a change to
`.railway/railway.ts` needs `pnpm railway:apply` as well.

The health check passes on `{"status":"ok"}` and emits a **warning** — not a failure —
when the response says `apiConfigured: false`. A dashboard that cannot reach an API
serves a page that can do nothing, which is worth saying out loud, but it is fixed by
editing a variable rather than by failing the deploy.

---

## Publishing the CLI

### One-time setup

`sentinel0` publishes with **npm trusted publishing** — no `NPM_TOKEN` in GitHub.
On npmjs.com, under the package's **Settings → Trusted Publisher**, set:

| Field | Value |
|---|---|
| Repository | `maxigimenez/sentinel0` |
| Workflow | `publish-cli.yml` |
| Environment | `npm` |

> **If publishing suddenly fails with a permissions error**, check this first. The
> workflow was renamed from `release.yml` to `publish-cli.yml`, and trusted publishing
> matches on the workflow *filename*. A stale entry there rejects the publish with an
> error that does not mention the rename.

### Publishing

From the Actions tab — *Publish sentinel0 → Run workflow* — or by publishing a
GitHub release.

Inputs:

- **version** — optional. Runs `pnpm version:set`, which moves the root, every
  `packages/*`, and the internal `@sentinel0/*` dependency pins together. They must move
  in lockstep: those packages are unpublished and the CLI links them by version, so a
  stale pin falls through to the npm registry and fails to resolve on a user's machine.
- **dry_run** — packs, inspects and verifies without publishing.

Before publishing it runs lint, the full test suite, and a build, then checks two
things that only fail on a user's machine:

- **the entry point is executable.** `tsc` emits `0644`, and a global install symlinks
  `sentinel0` straight at the compiled file, so without the exec bit the command fails
  with `permission denied`. `pnpm build` sets it; this asserts it.
- **the internal packages are in the tarball.** `@sentinel0/common` and
  `@sentinel0/orchestrator` are bundled rather than fetched from npm, so if
  `prepare-package.mjs` misses one the install succeeds and the command then fails at
  runtime.

### Doing it by hand

```bash
pnpm version:set 0.0.4                 # every package, and the cli's internal pins
pnpm install --lockfile-only           # the lockfile records those pins
pnpm lint && pnpm test && pnpm build

cd packages/cli
pnpm pack:tarball                     # runs prepack, then restores workspace links
tar -tzf sentinel0-*.tgz | head    # inspect before shipping

pnpm publish:package
```

`prepack` dereferences the pnpm symlinks into real directories so the internal packages
can be bundled; `postpack` restores them. If a pack is interrupted, re-run
`pnpm install` to put the workspace back.

To test a tarball without publishing:

```bash
mkdir /tmp/t && cd /tmp/t && npm init -y
npm install /path/to/sentinel0-0.0.4.tgz
./node_modules/.bin/sentinel0 --version
```

---

## The CLI bundle

`@sentinel0/common` and `@sentinel0/orchestrator` are unpublished. They ship *inside* the
tarball as `bundleDependencies`, which has one consequence worth internalising:

> **A bundled package ships without its own dependencies.** `prepare-package.mjs` writes
> each one a minimal manifest carrying no `dependencies` at all, so npm never learns
> that the orchestrator needs `p-limit`, `fastify`, `@fastify/cors` and `strip-ansi`.
> Nothing installs them. The install succeeds; the first `sentinel0 start` on a user's
> machine dies with `ERR_MODULE_NOT_FOUND`.

So **`packages/cli/package.json` must declare every third-party dependency of every
package it bundles**, at the same version. Three things enforce it:

- `packages/cli/test/bundled-dependencies.test.ts` compares the manifests, and runs on
  every PR.
- `prepare-package.mjs` refuses to pack if they disagree.
- `publish-cli.yml` installs the packed tarball into a clean directory and runs
  [`verify-bundled-imports.mjs`](../.github/scripts/verify-bundled-imports.mjs), which
  checks that every package *and subpath* the bundled code imports is reachable.

That last one is the only check that sees the tarball the way a user does. It exists
because `parallax-cli` 0.2.0 — this package under its former name — shipped broken
past a pack-install-and-run test: `--version` and `preflight` never reach the
orchestrator's entry point, so the import that fails is never evaluated.

### The second half: a bundled manifest is derived, never written

The minimal manifest also carries `exports`, and that half has its own failure:

> **A bundled package's `exports` is the only one Node consults.** Inside the tarball
> there is no pnpm symlink back to `packages/common`, so a subpath missing from the
> written manifest is unreachable however well it resolves in the workspace.

0.0.3 shipped that way. `prepare-package.mjs` hand-wrote `@sentinel0/common`'s exports
as a literal listing `.` and `./executor`; the package had grown `./github`,
`./prompt-catalog`, `./route-catalog` and `./route-validation`. `sentinel0 start` died
on its first import with `ERR_PACKAGE_PATH_NOT_EXPORTED`, and nothing caught it —
every test resolves through the symlink, and `verify-bundled-imports.mjs` collapsed
`@sentinel0/common/github` to `@sentinel0/common`, which was right there.

So the manifest is now **derived from the workspace manifest**
(`bundledManifest()` keeps `name`, `version`, `type`, `main`, `types`, `exports`,
`bin` and drops the rest), which makes the drift unrepresentable. Three checks stand
behind it, and each covers something the others cannot see:

- `packages/cli/test/bundled-manifest.test.ts` asserts the derivation carries `exports`
  verbatim, drops `dependencies`, names only built files, and — the one that reads the
  code rather than the manifests — that every `@sentinel0/common/<subpath>` imported
  anywhere in `packages/*/src` is declared.
- `prepare-package.mjs` refuses to pack a manifest naming a file the build did not emit.
- `verify-bundled-imports.mjs` checks subpaths against the installed `exports` map.

**Adding a subpath to `@sentinel0/common` therefore means editing exactly one file:**
`packages/common/package.json`. Nothing in the CLI needs to learn about it.

### Adding another internal package

1. `dependencies` and `bundleDependencies` in `packages/cli/package.json`
2. `bundledPackages` in `packages/cli/scripts/prepare-package.mjs` — name and
   `sourceDir` only; its manifest is derived from its own `package.json`
3. `BUNDLED` in `packages/cli/test/bundled-manifest.test.ts` and
   `bundled-dependencies.test.ts`
4. the tarball assertion in `publish-cli.yml`
5. its third-party `dependencies`, copied into the CLI's own

---

## Railway scripts

The raw CLI commands are wrapped, so nobody has to remember which verb does what:

| Script | Command | What it does |
|---|---|---|
| `pnpm railway:plan` | `railway config plan` | Previews. Changes nothing. |
| `pnpm railway:apply` | `railway config apply` | Reconciles the project with `.railway/railway.ts`. |
| `pnpm railway:deploy:api` | `railway up --service api` | Ships source to the control plane. |
| `pnpm railway:deploy:dashboard` | `railway up --service dashboard` | Ships source to the dashboard. |

**`apply` and `deploy` are different verbs.** `apply` reconciles configuration —
builders, Dockerfile paths, start commands, health checks. `deploy` uploads source. A
change to `.railway/railway.ts` followed by only a deploy leaves the service building
whatever it was last told to.

---

## Secrets and variables

| Name | Kind | Used by | Required |
|---|---|---|---|
| `RAILWAY_TOKEN` | secret | deploy-cloud-api, deploy-dashboard | yes |
| `CLOUD_HEALTH_URL` | variable | deploy-cloud-api | no |
| `DASHBOARD_HEALTH_URL` | variable | deploy-dashboard | no |
| npm trusted publishing | npm-side config | publish-cli | yes |

One `RAILWAY_TOKEN` covers both services: a project token reaches every service in the
project, and `--service` picks which one.

Only `publish-cli` declares a GitHub **environment** (`npm`), and it has to: npm's
trusted publisher is configured against that environment name as well as the repository
and workflow filename. Changing or removing it breaks publishing with an error that
does not mention the environment.

The deploy workflows declare none. They did, and every merge then wrote a failed
deployment to the repository's Environments page — noise from a deploy nobody asked
for. If you later want an approval gate on deploys, add `environment:` back to the job
and configure required reviewers under **Settings → Environments**; deploys stay
manual either way.
