import { TICKET_PROVIDER, type AppConfig } from '@sentinel0/common'
import type { LocalExecutor } from '@sentinel0/common/executor'
import { HermesClient } from '../hermes/client.js'
import { logger } from '../logger.js'

/**
 * Fail-fast checks run at boot and on every reload.
 *
 * Scoped to what the runner genuinely needs now: a reachable Hermes gateway
 * with a working key per profile, tracker credentials, and nothing else. The
 * predecessor also required git, pnpm, and a local agent CLI -- none of which
 * this runner touches, because it no longer executes anything itself.
 */
export async function validateRuntimeRequirements(
  config: AppConfig,
  executor: LocalExecutor
): Promise<void> {
  if (!config.hermes) {
    throw new Error('No Hermes gateway configured. Run "sentinel0 init".')
  }

  const enabled = config.hermes.profiles.filter((profile) => profile.enabled)
  if (enabled.length === 0) {
    throw new Error('No enabled Hermes profiles. Enable at least one and reload.')
  }

  const requiresLinear = config.projects.some(
    (project) => project.provider === TICKET_PROVIDER.LINEAR
  )
  if (requiresLinear && !process.env.LINEAR_API_KEY) {
    throw new Error('LINEAR_API_KEY missing; required by at least one Linear project.')
  }

  const requiresGitHub = config.projects.some(
    (project) => project.provider === TICKET_PROVIDER.GITHUB
  )
  if (requiresGitHub) {
    // Not fatal, but worth saying out loud: without a githubLogin an agent
    // cannot be targeted by GitHub identity, so every route that names it is
    // dead -- and a dead route reports nothing at all.
    const anonymous = enabled.filter((profile) => !profile.githubLogin)
    if (anonymous.length > 0) {
      logger.warn(
        `No githubLogin set for ${anonymous.map((p) => `"${p.name}"`).join(', ')}. ` +
          'PR routes that target an agent by GitHub account cannot match it.'
      )
    }

    const check = await executor.executeCommand(['gh', 'auth', 'status'], { cwd: process.cwd() })
    if (check.exitCode === 127) {
      throw new Error('GitHub CLI not found. Install gh and run "gh auth login".')
    }
    if (check.exitCode !== 0) {
      throw new Error('GitHub CLI is not authenticated. Run "gh auth login".')
    }
  }
}

export interface HermesProbeResult {
  profile: string
  ok: boolean
  detail: string
}

/**
 * Probes every configured profile.
 *
 * Reports per profile rather than throwing on the first failure: when three of
 * five profiles are misconfigured, an operator wants all three names at once.
 */
export async function probeHermes(config: AppConfig): Promise<HermesProbeResult[]> {
  if (!config.hermes) {
    return []
  }

  return Promise.all(
    config.hermes.profiles.map(async (profile) => {
      if (!profile.enabled) {
        return { profile: profile.name, ok: true, detail: 'disabled' }
      }
      try {
        const client = new HermesClient({
          baseUrl: config.hermes!.baseUrl,
          profile: profile.name,
          apiKey: profile.apiKey,
        })
        const capabilities = await client.capabilities()
        return {
          profile: profile.name,
          ok: true,
          detail: capabilities.model ?? capabilities.platform ?? 'reachable',
        }
      } catch (error: unknown) {
        return {
          profile: profile.name,
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        }
      }
    })
  )
}
