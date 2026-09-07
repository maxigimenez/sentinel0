import { INTEGRATION_PROVIDER, TICKET_PROVIDER, type AppConfig } from '@sentinel0/common'
import { HermesClient } from '../hermes/client.js'
import type { IntegrationStore } from '../integrations/store.js'
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
  integrations: IntegrationStore
): Promise<void> {
  if (!config.hermes) {
    throw new Error('No Hermes gateway configured. Run "sentinel0 init".')
  }

  const enabled = config.hermes.profiles.filter((profile) => profile.enabled)
  if (enabled.length === 0) {
    throw new Error('No enabled Hermes profiles. Enable at least one and reload.')
  }

  // Credentials are checked per project, not per provider: an organization
  // default covers most of them, and a project carrying its own override is
  // exactly the one whose absence a provider-wide check would miss.
  for (const project of config.projects) {
    if (project.provider !== TICKET_PROVIDER.LINEAR) {
      continue
    }
    if (!integrations.has(INTEGRATION_PROVIDER.LINEAR, project.id)) {
      throw new Error(
        `No Linear credential for project "${project.id}". ` +
          'Add one under Settings → Integrations, or set LINEAR_API_KEY.'
      )
    }
  }

  const gitHubProjects = config.projects.filter(
    (project) => project.provider === TICKET_PROVIDER.GITHUB
  )
  if (gitHubProjects.length > 0) {
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

    // Formerly `gh auth status`. Sentinel0 no longer shells out to the GitHub
    // CLI at all, so what has to exist is a token -- whether it came from the
    // cloud or from GITHUB_TOKEN on this machine.
    for (const project of gitHubProjects) {
      if (!integrations.has(INTEGRATION_PROVIDER.GITHUB, project.id)) {
        throw new Error(
          `No GitHub credential for project "${project.id}". ` +
            'Add one under Settings → Integrations, or set GITHUB_TOKEN.'
        )
      }
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
