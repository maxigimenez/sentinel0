import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { CONFIG_VERSION } from '@sentinel0/common'
import { loadConfig } from '../src/config-loader.js'
import { readConfigStore, writeConfigStore, emptyStoredConfig } from '../src/config-store.js'

const ENV_KEYS = [
  'SENTINEL0_DATA_DIR',
  'SENTINEL0_CONCURRENCY',
  'SENTINEL0_SERVER_API_PORT',
  'SENTINEL0_NETWORK_ACCESS',
] as const

const saved = new Map<string, string | undefined>()
let dataDir = ''

beforeEach(async () => {
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key])
    delete process.env[key]
  }
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sentinel0-config-'))
  process.env.SENTINEL0_DATA_DIR = dataDir
})

afterEach(async () => {
  for (const key of ENV_KEYS) {
    const value = saved.get(key)
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  delete process.env.SOME_SECRET
  await fs.rm(dataDir, { recursive: true, force: true })
})

async function writeRaw(config: object): Promise<void> {
  await fs.writeFile(path.join(dataDir, 'config.json'), JSON.stringify(config, null, 2))
}

function validConfig(overrides: object = {}) {
  return {
    version: CONFIG_VERSION,
    cloud: null,
    hermes: {
      baseUrl: 'http://127.0.0.1:8642',
      profiles: [{ name: 'product', apiKey: 'k', enabled: true, role: 'product' }],
    },
    projects: [{ id: 'taplands', provider: 'linear', filters: { team: 'ENG' } }],
    secrets: {},
    updatedAt: Date.now(),
    ...overrides,
  }
}

describe('readConfigStore', () => {
  it('returns an empty v2 config when the file does not exist', async () => {
    await expect(readConfigStore(dataDir)).resolves.toEqual(emptyStoredConfig())
  })

  it('refuses a v1 config with an actionable message rather than guessing a migration', async () => {
    await writeRaw({ version: 1, projects: [], slack: null, secrets: {} })
    await expect(readConfigStore(dataDir)).rejects.toThrow(/version 1.*requires version 2/s)
    await expect(readConfigStore(dataDir)).rejects.toThrow(/sentinel0 init/)
  })

  it('treats a config with no version field as v1', async () => {
    await writeRaw({ projects: [] })
    await expect(readConfigStore(dataDir)).rejects.toThrow(/version 1/)
  })

  it('refuses a config from a newer build', async () => {
    await writeRaw({ version: CONFIG_VERSION + 1 })
    await expect(readConfigStore(dataDir)).rejects.toThrow(/newer than this build/)
  })

  it('round-trips through writeConfigStore and stamps the version', async () => {
    await writeConfigStore(dataDir, { ...emptyStoredConfig(), version: 0 })
    const stored = await readConfigStore(dataDir)
    expect(stored.version).toBe(CONFIG_VERSION)
    expect(stored.updatedAt).toBeGreaterThan(0)
  })

  it('reports malformed JSON with the path', async () => {
    await fs.writeFile(path.join(dataDir, 'config.json'), '{ not json')
    await expect(readConfigStore(dataDir)).rejects.toThrow(/Invalid config at .*config\.json/)
  })
})

describe('loadConfig', () => {
  it('round-trips the scoped Linear bot identity and repository', async () => {
    await writeRaw(
      validConfig({
        hermes: {
          baseUrl: 'http://localhost:8642',
          profiles: [{ name: 'coder', apiKey: 'k', linearUserId: 'u', linearWorkspaceId: 'w' }],
        },
        projects: [
          { id: 'eng', provider: 'linear', filters: { team: 'ENG', repository: 'acme/platform' } },
        ],
      })
    )
    const config = await loadConfig()
    expect(config.hermes?.profiles[0]).toMatchObject({ linearUserId: 'u', linearWorkspaceId: 'w' })
    expect(config.projects[0].filters.repository).toBe('acme/platform')
  })
  it('rejects an unscoped Linear identity', async () => {
    await writeRaw(
      validConfig({
        hermes: {
          baseUrl: 'http://localhost:8642',
          profiles: [{ name: 'coder', apiKey: 'k', linearUserId: 'u' }],
        },
      })
    )
    await expect(loadConfig()).rejects.toThrow('both linearUserId and linearWorkspaceId')
  })
  it('loads projects and hermes profiles', async () => {
    await writeRaw(validConfig())
    const config = await loadConfig()

    expect(config.projects).toEqual([
      { id: 'taplands', provider: 'linear', filters: { team: 'ENG' } },
    ])
    expect(config.hermes?.profiles[0]).toMatchObject({ name: 'product', enabled: true })
    expect(config.cloud).toBeNull()
  })

  it('keeps profile-targeted legacy configurations valid when profiles share a GitHub account', async () => {
    await writeRaw(
      validConfig({
        hermes: {
          baseUrl: 'http://h',
          profiles: [
            { name: 'product', apiKey: 'p', githubLogin: 'bot' },
            { name: 'reviewer', apiKey: 'r', githubLogin: 'bot' },
          ],
        },
      })
    )
    expect((await loadConfig()).hermes?.profiles).toHaveLength(2)
  })

  it('normalizes a trailing slash off the hermes base url', async () => {
    await writeRaw(
      validConfig({
        hermes: {
          baseUrl: 'http://127.0.0.1:8642/',
          profiles: [{ name: 'p', apiKey: 'k' }],
        },
      })
    )
    const config = await loadConfig()
    expect(config.hermes?.baseUrl).toBe('http://127.0.0.1:8642')
  })

  it('defaults a profile to enabled when the flag is omitted', async () => {
    await writeRaw(
      validConfig({
        hermes: { baseUrl: 'http://h', profiles: [{ name: 'p', apiKey: 'k' }] },
      })
    )
    const config = await loadConfig()
    expect(config.hermes?.profiles[0].enabled).toBe(true)
  })

  it('rejects a profile with no api key, which would 401 on a named prefix', async () => {
    await writeRaw(
      validConfig({ hermes: { baseUrl: 'http://h', profiles: [{ name: 'product' }] } })
    )
    await expect(loadConfig()).rejects.toThrow(/apiKey \("product"\) must be a non-empty string/)
  })

  it('rejects duplicate profile names', async () => {
    await writeRaw(
      validConfig({
        hermes: {
          baseUrl: 'http://h',
          profiles: [
            { name: 'p', apiKey: 'a' },
            { name: 'p', apiKey: 'b' },
          ],
        },
      })
    )
    await expect(loadConfig()).rejects.toThrow(/Duplicate hermes profile "p"/)
  })

  it('rejects a non-http hermes base url', async () => {
    await writeRaw(
      validConfig({
        hermes: { baseUrl: 'ftp://h', profiles: [{ name: 'p', apiKey: 'k' }] },
      })
    )
    await expect(loadConfig()).rejects.toThrow(/must use http or https/)
  })

  it('rejects duplicate project ids', async () => {
    await writeRaw(
      validConfig({
        projects: [
          { id: 'dup', provider: 'linear', filters: { team: 'A' } },
          { id: 'dup', provider: 'linear', filters: { team: 'B' } },
        ],
      })
    )
    await expect(loadConfig()).rejects.toThrow(/Duplicate project id "dup"/)
  })

  it('requires owner and repo for a github project', async () => {
    await writeRaw(
      validConfig({ projects: [{ id: 'gh', provider: 'github', filters: { owner: 'me' } }] })
    )
    await expect(loadConfig()).rejects.toThrow(/filters\.repo for "gh"/)
  })

  it('injects secrets into the environment without clobbering existing values', async () => {
    process.env.SOME_SECRET = 'from-env'
    await writeRaw(validConfig({ secrets: { SOME_SECRET: 'from-config', OTHER: 'set' } }))

    await loadConfig()

    expect(process.env.SOME_SECRET).toBe('from-env')
    expect(process.env.OTHER).toBe('set')
    delete process.env.OTHER
  })

  it('reads runtime knobs from the environment', async () => {
    await writeRaw(validConfig())
    process.env.SENTINEL0_CONCURRENCY = '5'
    process.env.SENTINEL0_SERVER_API_PORT = '9999'
    process.env.SENTINEL0_NETWORK_ACCESS = 'true'

    const config = await loadConfig()

    expect(config.concurrency).toBe(5)
    expect(config.server).toEqual({ apiPort: 9999, networkAccess: true })
  })

  it('rejects out-of-range runtime knobs instead of silently clamping', async () => {
    await writeRaw(validConfig())
    process.env.SENTINEL0_CONCURRENCY = '99'
    await expect(loadConfig()).rejects.toThrow(/between 1 and 16/)

    process.env.SENTINEL0_CONCURRENCY = '2'
    process.env.SENTINEL0_NETWORK_ACCESS = 'yes'
    await expect(loadConfig()).rejects.toThrow(/must be "true" or "false"/)
  })
})
