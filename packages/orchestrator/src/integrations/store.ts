import {
  INTEGRATION_PROVIDER,
  resolveIntegration,
  type IntegrationProvider,
  type ResolvedIntegration,
} from '@sentinel0/common'
import type { CloudClient } from '../cloud/client.js'
import { logger } from '../logger.js'
import { errorMessage } from '../runtime/errors.js'

/**
 * The environment variable each provider falls back to.
 *
 * These are the credentials `sentinel0 init` writes into `config.json`, which
 * `loadConfig` inherits into the process environment. They remain supported
 * for two cases the cloud cannot serve: a runner with no control plane at all,
 * and a runner restarting while the cloud is unreachable.
 */
const FALLBACK_ENV: Record<IntegrationProvider, string> = {
  [INTEGRATION_PROVIDER.GITHUB]: 'GITHUB_TOKEN',
  [INTEGRATION_PROVIDER.LINEAR]: 'LINEAR_API_KEY',
}

/**
 * Tracker credentials, held in memory for the life of the process.
 *
 * **Nothing here is written to disk.** Routes and projects cache to
 * `~/.sentinel0/` so a cloud outage cannot stop the runner dispatching, and
 * the same argument would apply to credentials -- but a decrypted personal
 * access token sitting in a file is a materially worse trade than a runner
 * that needs its control plane once at boot. An operator who wants to survive
 * a restart during an outage sets the fallback environment variable, which is
 * their decision to make rather than ours to make for them.
 *
 * A refresh that fails leaves the previous credentials in place, for the same
 * reason: the token that worked a minute ago is a better guess than none.
 */
export class IntegrationStore {
  private credentials: ResolvedIntegration[] = []

  constructor(private readonly cloud?: CloudClient) {}

  /**
   * Reloads from the cloud.
   *
   * Called at boot and on every reload, alongside routes and projects, so a
   * credential rotated in the dashboard reaches the runner without a restart.
   */
  async refresh(): Promise<void> {
    if (!this.cloud) {
      return
    }
    try {
      const { integrations } = await this.cloud.fetchIntegrations()
      this.credentials = integrations
    } catch (error: unknown) {
      logger.warn(
        `Could not fetch integration credentials (${errorMessage(error)}); ` +
          `keeping ${this.credentials.length} already loaded.`
      )
    }
  }

  /** Whether a credential exists for this provider and project, from any source. */
  has(provider: IntegrationProvider, projectId: string): boolean {
    return this.lookup(provider, projectId) !== undefined
  }

  /**
   * The token to present, or a message naming what to do about its absence.
   *
   * Throwing rather than returning undefined is deliberate: every caller is
   * about to make an authenticated request, and a request sent without a token
   * fails as a confusing 401 from GitHub instead of a sentence naming the
   * screen that fixes it.
   */
  token(provider: IntegrationProvider, projectId: string): string {
    const token = this.lookup(provider, projectId)
    if (!token) {
      throw new Error(
        `No ${provider} credential for project "${projectId}". ` +
          `Add one under Settings → Integrations in the dashboard, ` +
          `or set ${FALLBACK_ENV[provider]} on this machine.`
      )
    }
    return token
  }

  /**
   * A token provider bound to one provider and project.
   *
   * The REST clients take a function rather than a string so that rotating a
   * credential -- or, later, a GitHub App installation token expiring -- is
   * picked up by the next request instead of the next process.
   */
  provider(provider: IntegrationProvider, projectId: string): () => Promise<string> {
    return async () => this.token(provider, projectId)
  }

  private lookup(provider: IntegrationProvider, projectId: string): string | undefined {
    const match = resolveIntegration(
      this.credentials.filter((credential) => credential.provider === provider),
      projectId
    )
    return match?.token ?? process.env[FALLBACK_ENV[provider]] ?? undefined
  }
}
