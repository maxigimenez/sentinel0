import type { AgentDescriptor, HermesConfig, HermesProfileConfig } from '@sentinel0/common'
import { HermesClient } from './client.js'

export interface DiscoveryFailure {
  profile: string
  error: string
}

export interface DiscoveryResult {
  agents: AgentDescriptor[]
  failures: DiscoveryFailure[]
}

/**
 * Reads one Hermes profile's advertised surface into an `AgentDescriptor`.
 *
 * Only `/v1/capabilities` is required — it is the endpoint that proves the
 * profile is reachable and that this key authenticates against this prefix.
 * Skills and toolsets are enrichment: a profile that has none, or a build that
 * does not expose those routes, still yields a usable agent.
 */
export async function discoverProfile(
  client: HermesClient,
  profile: HermesProfileConfig,
  now: number = Date.now()
): Promise<AgentDescriptor> {
  const capabilities = await client.capabilities()

  const [models, skills, toolsets] = await Promise.all([
    client.models().catch(() => []),
    client.skills().catch(() => []),
    client.toolsets().catch(() => []),
  ])

  return {
    profile: profile.name,
    displayName: capabilities.model ?? models[0]?.id ?? profile.name,
    role: profile.role,
    model: capabilities.model ?? models[0]?.id,
    provider: capabilities.platform,
    toolsets: toolsets.filter((entry) => entry.enabled !== false).map((entry) => entry.name),
    skills: skills.map((entry) => entry.name),
    githubLogin: profile.githubLogin,
    linearUserId: profile.linearUserId,
    linearWorkspaceId: profile.linearWorkspaceId,
    avatarUrl: profile.avatarUrl,
    enabled: profile.enabled,
    discoveredAt: now,
  }
}

export function createClientForProfile(
  hermes: HermesConfig,
  profile: HermesProfileConfig
): HermesClient {
  return new HermesClient({
    baseUrl: hermes.baseUrl,
    profile: profile.name,
    apiKey: profile.apiKey,
  })
}

/**
 * Discovers every enabled profile.
 *
 * Failures are collected rather than thrown: one profile with a stale
 * `API_SERVER_KEY` must not hide the other five from the registry. Callers are
 * expected to surface `failures` — silently returning a short list would let a
 * misconfigured agent look like a deleted one.
 */
export async function discoverAgents(
  hermes: HermesConfig,
  now: number = Date.now()
): Promise<DiscoveryResult> {
  const agents: AgentDescriptor[] = []
  const failures: DiscoveryFailure[] = []

  const enabled = hermes.profiles.filter((profile) => profile.enabled)

  const settled = await Promise.all(
    enabled.map(async (profile) => {
      try {
        return {
          profile,
          agent: await discoverProfile(createClientForProfile(hermes, profile), profile, now),
        }
      } catch (error: unknown) {
        return {
          profile,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    })
  )

  for (const result of settled) {
    if ('agent' in result && result.agent) {
      agents.push(result.agent)
    } else if ('error' in result) {
      failures.push({ profile: result.profile.name, error: result.error as string })
    }
  }

  agents.sort((a, b) => a.profile.localeCompare(b.profile))
  return { agents, failures }
}
