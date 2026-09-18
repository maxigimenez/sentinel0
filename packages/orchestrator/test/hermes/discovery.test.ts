import { afterEach, describe, expect, it } from 'vitest'
import type { HermesConfig } from '@sentinel0/common'
import { discoverAgents } from '../../src/hermes/discovery.js'
import { startFakeHermes, type FakeHermes } from './fake-hermes-server.js'

let server: FakeHermes | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
})

function config(baseUrl: string, overrides: Partial<HermesConfig> = {}): HermesConfig {
  return {
    baseUrl,
    profiles: [{ name: 'default', apiKey: 'k', enabled: true }],
    ...overrides,
  }
}

describe('discoverAgents', () => {
  it('describes a reachable profile from its advertised surface', async () => {
    server = await startFakeHermes({})

    const { agents, failures } = await discoverAgents(
      config(server.baseUrl, {
        profiles: [
          {
            name: 'default',
            apiKey: 'k',
            enabled: true,
            role: 'product',
            githubLogin: 'bot',
            linearUserId: 'u',
            linearWorkspaceId: 'w',
          },
        ],
      }),
      123
    )

    expect(failures).toEqual([])
    expect(agents).toEqual([
      {
        profile: 'default',
        displayName: 'hermes-agent',
        role: 'product',
        model: 'hermes-agent',
        provider: 'hermes-agent',
        toolsets: ['core'],
        skills: ['github-pr-workflow'],
        githubLogin: 'bot',
        linearUserId: 'u',
        linearWorkspaceId: 'w',
        enabled: true,
        discoveredAt: 123,
      },
    ])
  })

  it('skips disabled profiles without calling them', async () => {
    server = await startFakeHermes({})

    const { agents } = await discoverAgents(
      config(server.baseUrl, {
        profiles: [{ name: 'default', apiKey: 'k', enabled: false }],
      })
    )

    expect(agents).toEqual([])
    expect(server.requests).toEqual([])
  })

  it('reports a bad key as a failure instead of hiding the healthy profiles', async () => {
    server = await startFakeHermes({ requireBearer: 'right-key' })

    const { agents, failures } = await discoverAgents(
      config(server.baseUrl, {
        profiles: [
          { name: 'default', apiKey: 'right-key', enabled: true },
          { name: 'product', apiKey: 'wrong-key', enabled: true },
        ],
      })
    )

    expect(agents.map((agent) => agent.profile)).toEqual(['default'])
    expect(failures).toHaveLength(1)
    expect(failures[0].profile).toBe('product')
    expect(failures[0].error).toContain('401')
  })

  it('returns agents in a stable order regardless of config order', async () => {
    server = await startFakeHermes({})

    const { agents } = await discoverAgents(
      config(server.baseUrl, {
        profiles: [
          { name: 'default', apiKey: 'k', enabled: true },
          { name: 'coder', apiKey: 'k', enabled: true },
        ],
      })
    )

    // 'coder' is a named profile, so it is served under /p/coder by the same fake.
    expect(agents.map((agent) => agent.profile)).toEqual(['coder', 'default'])
  })
})
