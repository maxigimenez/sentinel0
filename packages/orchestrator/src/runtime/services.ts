import { INTEGRATION_PROVIDER, TICKET_PROVIDER, type ProjectConfig } from '@sentinel0/common'
import { GitHubService } from '../github/service.js'
import { GitHubRestClient } from '@sentinel0/common/github'
import { LinearService } from '../linear/service.js'
import type { IntegrationStore } from '../integrations/store.js'
import type { TrackerWriter, TriggerSource } from '../triggers/types.js'

/**
 * One tracker client per project, not one per provider.
 *
 * Credentials are resolved per project -- an organization default, overridden
 * where a project needs a different account -- so two GitHub projects can be
 * watched by two different tokens. A single shared client could only ever hold
 * one of them, which is why this is keyed by project id rather than by
 * `github` and `linear`.
 */
export interface ProviderServices {
  for(project: ProjectConfig): GitHubService | LinearService
}

export function buildProviderServices(integrations: IntegrationStore): ProviderServices {
  const cache = new Map<string, GitHubService | LinearService>()

  return {
    for(project: ProjectConfig) {
      const existing = cache.get(project.id)
      if (existing) {
        return existing
      }

      const service =
        project.provider === TICKET_PROVIDER.GITHUB
          ? new GitHubService(
              new GitHubRestClient(integrations.provider(INTEGRATION_PROVIDER.GITHUB, project.id))
            )
          : new LinearService(integrations.provider(INTEGRATION_PROVIDER.LINEAR, project.id))

      cache.set(project.id, service)
      return service
    },
  }
}

export function triggerSourceFor(
  project: ProjectConfig,
  services: ProviderServices
): TriggerSource {
  return services.for(project)
}

export function trackerWriterFor(
  project: ProjectConfig,
  services: ProviderServices
): TrackerWriter {
  return services.for(project)
}
