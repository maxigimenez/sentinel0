import chalk from 'chalk'
import type { CliContext, VerifyCheck } from '../types.js'
import { getJson } from '../api.js'
import { findCapableNode } from '../node-runtime.js'

/**
 * Checks exactly what this runner needs.
 *
 * Notably absent: git, pnpm, and any agent CLI. The runner does not execute
 * agents or touch a repository any more -- Hermes does both -- so requiring
 * them here would fail machines that are in fact correctly configured.
 */
export async function runPreflight(context: CliContext): Promise<void> {
  const checks: VerifyCheck[] = []

  // Capability, not version: what matters is whether node:sqlite loads, and
  // which interpreter the runner will actually be started with.
  const runtime = findCapableNode(context.defaultDataDir)
  checks.push({
    name: 'A Node that can load node:sqlite',
    ok: Boolean(runtime),
    required: true,
    detail: runtime
      ? `${runtime.version ?? '?'} at ${runtime.binary}`
      : `none found (running ${process.version})`,
  })

  const config = await context.loadStoredConfig()

  checks.push({
    name: 'Configuration present',
    ok: Boolean(config.hermes && config.cloud),
    required: true,
    detail: config.hermes && config.cloud ? '~/.sentinel0/config.json' : 'run "sentinel0 init"',
  })

  if (config.hermes) {
    for (const profile of config.hermes.profiles.filter((entry) => entry.enabled)) {
      const prefix = profile.name === 'default' ? '' : `/p/${profile.name}`
      let detail = ''
      let ok = false
      try {
        const capabilities = await getJson<{ model?: string; platform?: string }>(
          `${config.hermes.baseUrl}${prefix}/v1/capabilities`,
          { authorization: `Bearer ${profile.apiKey}` }
        )
        ok = true
        detail = capabilities.model ?? capabilities.platform ?? 'reachable'
      } catch (error: unknown) {
        detail = error instanceof Error ? error.message : String(error)
      }
      checks.push({ name: `Hermes profile "${profile.name}"`, ok, required: true, detail })
    }
  }

  if (config.cloud) {
    let ok = false
    let detail = ''
    try {
      const health = await getJson<{ status: string }>(`${config.cloud.baseUrl}/health`)
      ok = health.status === 'ok'
      detail = config.cloud.baseUrl
    } catch (error: unknown) {
      detail = error instanceof Error ? error.message : String(error)
    }
    checks.push({ name: 'Sentinel0 cloud reachable', ok, required: true, detail })
  }

  /*
   * Credentials, not command-line tools.
   *
   * This used to check for `gh` and `gh auth status`. Sentinel0 no longer
   * shells out to the GitHub CLI, and the machine it runs on may not be able
   * to install it -- which is what prompted the change. What matters now is
   * whether a token exists, and the authoritative copy of that lives in the
   * cloud, so a missing local one is only worth reporting as the fallback it
   * is.
   */
  const localGitHub = Boolean(process.env.GITHUB_TOKEN || config.secrets.GITHUB_TOKEN)
  checks.push({
    name: 'GITHUB_TOKEN (local fallback)',
    ok: localGitHub,
    required: false,
    detail: localGitHub
      ? ''
      : 'Optional. Settings → Integrations in the dashboard is the usual place.',
  })

  const localLinear = Boolean(process.env.LINEAR_API_KEY || config.secrets.LINEAR_API_KEY)
  checks.push({
    name: 'LINEAR_API_KEY (local fallback)',
    ok: localLinear,
    required: false,
    detail: localLinear
      ? ''
      : 'Optional. Settings → Integrations in the dashboard is the usual place.',
  })

  console.log('')
  for (const check of checks) {
    const mark = check.ok
      ? chalk.green('ok  ')
      : check.required
        ? chalk.red('FAIL')
        : chalk.yellow('warn')
    const suffix = check.detail ? chalk.dim(`  ${check.detail}`) : ''
    console.log(`  ${mark}  ${check.name}${suffix}`)
  }

  const failed = checks.filter((check) => check.required && !check.ok)
  console.log('')
  if (failed.length > 0) {
    console.log(chalk.red(`Verdict: FAIL (${failed.length} required check(s))`))
    process.exitCode = 1
    return
  }
  console.log(chalk.green('Verdict: ready'))
}
