import { defineRailway, postgres, preserve, project, service, volume } from 'railway/iac'

/**
 * The Railway project, in code.
 *
 * This replaces the per-service `railway.json` files. Config as Code is
 * deprecated — Railway stopped letting a service opt in on 2026-08-28 and
 * retires the mechanism on 2026-12-01 — and the API now refuses to set a
 * service's config file path at all.
 *
 * Describing both services in one file is better than what it replaces. There
 * is no root `railway.json` for a new service to inherit by accident, so the
 * failure that prompted this — the dashboard service silently building and
 * deploying the control plane's image, then passing its health check while
 * serving the wrong thing — is not merely fixed but unrepresentable. Every
 * service's builder and Dockerfile are stated here, next to each other.
 *
 *   pnpm railway:plan     preview, changes nothing
 *   pnpm railway:apply    apply after review
 *
 * `restartPolicyType` is deliberately absent. It is applied and live as
 * ON_FAILURE on both services, but it is also Railway's default, and the plan
 * reader reports it as unset — so declaring it makes every plan show two
 * phantom changes forever. A plan that never reads clean is one nobody reads,
 * which costs more than restating a default is worth. `restartPolicyMaxRetries`
 * stays, because 5 is not the default.
 */
export default defineRailway(() => {
  const Postgres = postgres('Postgres', { region: 'europe-west4-drams3a' })

  const postgresVolume = volume('postgres-volume', {
    alerts: { usage: { '80': {}, '95': {}, '100': {} } },
    allowOnlineResize: true,
    region: 'europe-west4-drams3a',
    sizeMB: 500,
  })

  // The control plane. Migrations run as a pre-deploy step so the schema is in
  // place before the new container takes traffic, and so a failed migration
  // stops the rollout rather than being discovered by the first request.
  const api = service('api', {
    build: { builder: 'DOCKERFILE', dockerfilePath: 'Dockerfile' },
    deploy: {
      startCommand: 'node dist/index.js',
      preDeployCommand: ['node dist/migrate-cli.js'],
      healthcheckPath: '/health',
      healthcheckTimeout: 30,
      restartPolicyMaxRetries: 5,
    },
    replicas: { 'europe-west4-drams3a': 1 },
    /*
     * `env` is reconciled, not merged: a variable set in the Railway dashboard
     * and absent here is *removed* on apply. So every variable the service
     * reads is declared, whether or not it is set today — a name listed with
     * `preserve()` that does not exist yet is a no-op, while a name omitted is
     * a deletion waiting for the next `railway config apply`.
     *
     * `preserve()` keeps whatever value Railway already holds without writing
     * a credential into source. That is not a convenience for the secrets: it
     * is the only reason they can be declared here at all.
     */
    env: {
      DATABASE_URL: preserve(),
      // Required before any tracker credential can be stored: 32 random bytes
      // encrypting them at rest. Losing it makes every stored token
      // unreadable, so it must survive an apply.
      SENTINEL0_SECRET_KEY: preserve(),
      DASHBOARD_URL: preserve(),
      CORS_ORIGINS: preserve(),
      LOG_LEVEL: preserve(),
      DATABASE_POOL_MAX: preserve(),
      DATABASE_SSL: preserve(),
      SLACK_WEBHOOK_HOST: preserve(),
    },
  })

  // The dashboard. Its own Dockerfile, and no pre-deploy command — it owns no
  // database and has nothing to migrate.
  const dashboard = service('dashboard', {
    build: { builder: 'DOCKERFILE', dockerfilePath: 'Dockerfile.dashboard' },
    deploy: {
      startCommand: 'node server.mjs',
      healthcheckPath: '/health',
      healthcheckTimeout: 30,
      restartPolicyMaxRetries: 5,
    },
    replicas: { 'europe-west4-drams3a': 1 },
    // Read at runtime by server.mjs and served as /env.js, so pointing the
    // dashboard at a different control plane is a restart, not a rebuild.
    env: { SENTINEL0_API_URL: preserve() },
  })

  return project('sentinel0', {
    resources: [api, dashboard, Postgres, postgresVolume],
  })
})
