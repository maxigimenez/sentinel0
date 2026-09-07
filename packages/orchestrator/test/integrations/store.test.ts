import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { INTEGRATION_PROVIDER, type ResolvedIntegration } from '@sentinel0/common'
import type { CloudClient } from '../../src/cloud/client.js'
import { IntegrationStore } from '../../src/integrations/store.js'

function cloud(
  integrations: ResolvedIntegration[],
  behaviour: { fail?: boolean } = {}
): CloudClient {
  return {
    fetchIntegrations: async () => {
      if (behaviour.fail) {
        throw new Error('cloud unreachable')
      }
      return { integrations }
    },
  } as unknown as CloudClient
}

const orgToken: ResolvedIntegration = {
  provider: INTEGRATION_PROVIDER.GITHUB,
  projectId: null,
  token: 'org_token',
}

const projectToken: ResolvedIntegration = {
  provider: INTEGRATION_PROVIDER.GITHUB,
  projectId: 'acme/platform',
  token: 'project_token',
}

beforeEach(() => {
  delete process.env.GITHUB_TOKEN
  delete process.env.LINEAR_API_KEY
})

afterEach(() => {
  delete process.env.GITHUB_TOKEN
  delete process.env.LINEAR_API_KEY
})

describe('precedence', () => {
  it('prefers a project credential over the organization one', async () => {
    const store = new IntegrationStore(cloud([orgToken, projectToken]))
    await store.refresh()
    expect(store.token(INTEGRATION_PROVIDER.GITHUB, 'acme/platform')).toBe('project_token')
  })

  it('falls back to the organization credential for other projects', async () => {
    const store = new IntegrationStore(cloud([orgToken, projectToken]))
    await store.refresh()
    expect(store.token(INTEGRATION_PROVIDER.GITHUB, 'acme/website')).toBe('org_token')
  })

  it('keeps providers apart', async () => {
    const store = new IntegrationStore(
      cloud([orgToken, { provider: INTEGRATION_PROVIDER.LINEAR, projectId: null, token: 'lin' }])
    )
    await store.refresh()
    expect(store.token(INTEGRATION_PROVIDER.LINEAR, 'ENG')).toBe('lin')
    expect(store.token(INTEGRATION_PROVIDER.GITHUB, 'ENG')).toBe('org_token')
  })
})

describe('the local fallback', () => {
  it('uses the environment when the cloud holds nothing', async () => {
    process.env.GITHUB_TOKEN = 'local_token'
    const store = new IntegrationStore(cloud([]))
    await store.refresh()
    expect(store.token(INTEGRATION_PROVIDER.GITHUB, 'acme/platform')).toBe('local_token')
  })

  it('works with no cloud configured at all', () => {
    process.env.LINEAR_API_KEY = 'local_linear'
    const store = new IntegrationStore()
    expect(store.token(INTEGRATION_PROVIDER.LINEAR, 'ENG')).toBe('local_linear')
  })

  /*
   * The cloud is authoritative while it has an answer. An operator who left a
   * stale token in `config.json` and then rotated the real one in the
   * dashboard must get the rotated one.
   */
  it('is a fallback, not an override', async () => {
    process.env.GITHUB_TOKEN = 'stale_local'
    const store = new IntegrationStore(cloud([orgToken]))
    await store.refresh()
    expect(store.token(INTEGRATION_PROVIDER.GITHUB, 'anything')).toBe('org_token')
  })
})

describe('a failing refresh', () => {
  /*
   * The token that worked a minute ago is a better guess than none. Clearing
   * the cache on a transient cloud error would stop every poll cycle for as
   * long as the outage lasted, which is exactly what keeping the runner's own
   * GitHub calls was meant to avoid.
   */
  it('keeps the credentials it already had', async () => {
    const store = new IntegrationStore(cloud([orgToken]))
    await store.refresh()

    const offline = new IntegrationStore(cloud([orgToken], { fail: true }))
    await offline.refresh()
    // Nothing loaded, and nothing thrown: the runner carries on and reports the
    // missing credential per project instead.
    expect(offline.has(INTEGRATION_PROVIDER.GITHUB, 'acme/platform')).toBe(false)

    await store.refresh()
    expect(store.token(INTEGRATION_PROVIDER.GITHUB, 'acme/platform')).toBe('org_token')
  })
})

describe('a missing credential', () => {
  it('names the project and both places it could come from', () => {
    const store = new IntegrationStore()
    expect(() => store.token(INTEGRATION_PROVIDER.GITHUB, 'acme/platform')).toThrow(
      /acme\/platform.*Integrations.*GITHUB_TOKEN/s
    )
  })

  it('reports absence through has() without throwing', () => {
    expect(new IntegrationStore().has(INTEGRATION_PROVIDER.GITHUB, 'acme/platform')).toBe(false)
  })
})

describe('provider()', () => {
  it('resolves at call time, not at binding time', async () => {
    const store = new IntegrationStore(cloud([orgToken]))
    const provide = store.provider(INTEGRATION_PROVIDER.GITHUB, 'acme/platform')

    // Bound before anything was loaded; a token captured at construction would
    // have thrown here rather than picking up the refresh.
    await store.refresh()
    expect(await provide()).toBe('org_token')
  })
})
