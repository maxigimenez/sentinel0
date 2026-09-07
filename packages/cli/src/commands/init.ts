import * as p from '@clack/prompts'
import chalk from 'chalk'
import { CONFIG_VERSION, type HermesProfileConfig, type StoredConfig } from '@sentinel0/common'
import type { CliContext } from '../types.js'
import { getJson } from '../api.js'
import {
  defaultHermesBaseUrl,
  discoverLocalHermes,
  resolveHermesHome,
  type LocalHermesProfile,
} from '../hermes-local.js'

const BRAND = chalk.hex('#f97316')

function assertNotCancel<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel('Setup cancelled.')
    process.exit(0)
  }
  return value as T
}

function requiredText(message: string, initialValue?: string, placeholder?: string) {
  return p.text({
    message,
    initialValue,
    placeholder,
    validate: (value) => (value?.trim() ? undefined : 'Required.'),
  })
}

/**
 * Verifies a Hermes profile before we write its key to disk.
 *
 * Catching a wrong key here is far cheaper than catching it as a 401 buried in
 * the runner log an hour later, and `/v1/capabilities` is the cheapest call that
 * proves both reachability and that this key works on this profile's prefix.
 */
async function probeProfile(
  baseUrl: string,
  profile: string,
  apiKey: string
): Promise<{ ok: boolean; detail: string }> {
  const prefix = profile === 'default' ? '' : `/p/${profile}`
  try {
    const capabilities = await getJson<{ model?: string; platform?: string }>(
      `${baseUrl.replace(/\/+$/, '')}${prefix}/v1/capabilities`,
      { authorization: `Bearer ${apiKey}` }
    )
    return { ok: true, detail: capabilities.model ?? capabilities.platform ?? 'reachable' }
  } catch (error: unknown) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

export async function runInit(context: CliContext): Promise<void> {
  p.intro(BRAND(' Sentinel0 — connect this machine to your agents '))

  const existing = await context.loadStoredConfig()

  // ── Cloud ────────────────────────────────────────────────
  p.log.step('Sentinel0 cloud')
  const cloudBaseUrl = assertNotCancel(
    await requiredText(
      'Cloud API base URL',
      existing.cloud?.baseUrl ?? '',
      'https://sentinel0-cloud.up.railway.app'
    )
  ).trim()

  const cloudApiKey = assertNotCancel(
    await p.password({
      message: 'Runner API key (snt_rnr_…)',
      validate: (value) =>
        value?.startsWith('snt_rnr_')
          ? undefined
          : 'Expected a runner key. Create one with the cloud org:create command.',
    })
  )

  const runnerName = assertNotCancel(
    await requiredText('Name for this runner', existing.cloud?.runnerName ?? 'cerebro')
  ).trim()

  // ── Hermes ───────────────────────────────────────────────
  p.log.step('Hermes gateway')

  const install = await discoverLocalHermes()

  if (install) {
    p.log.info(`Found a Hermes install at ${install.home}`)
    if (!install.apiServerEnabled) {
      p.log.warn(
        `API_SERVER_ENABLED is not set in ${install.home}/.env — the gateway will not serve an API.`
      )
    }
  } else {
    p.log.warn(
      `No Hermes install at ${resolveHermesHome()}. You can still configure profiles by hand.`
    )
  }

  const hermesBaseUrl = assertNotCancel(
    await requiredText(
      'Hermes API server base URL',
      existing.hermes?.baseUrl ?? defaultHermesBaseUrl(install)
    )
  ).trim()

  const previous = new Map(
    (existing.hermes?.profiles ?? []).map((profile) => [profile.name, profile])
  )

  /** Confirms one profile and collects the bits Sentinel0 needs beyond the key. */
  async function configureProfile(
    name: string,
    discovered?: LocalHermesProfile
  ): Promise<HermesProfileConfig | undefined> {
    const remembered = previous.get(name)

    // Prefer what is on disk: it is the key the gateway is actually serving.
    let apiKey = discovered?.apiKey ?? remembered?.apiKey
    if (apiKey) {
      p.log.info(
        `Using the API_SERVER_KEY from ${discovered?.apiKey ? discovered.envPath : 'your existing Sentinel0 config'}`
      )
    } else {
      apiKey = assertNotCancel(
        await p.password({
          message: `API_SERVER_KEY for "${name}"`,
          validate: (value) => (value?.trim() ? undefined : 'Required.'),
        })
      )
    }

    const spinner = p.spinner()
    spinner.start(`Checking ${name}`)
    const probe = await probeProfile(hermesBaseUrl, name, apiKey)
    spinner.stop(probe.ok ? `${name}: ${probe.detail}` : `${name}: unreachable`)

    if (!probe.ok) {
      p.log.error(probe.detail)
      const keep = assertNotCancel(
        await p.confirm({ message: `Add "${name}" anyway?`, initialValue: false })
      )
      if (!keep) {
        return undefined
      }
    }

    const role = assertNotCancel(
      await p.text({
        message: `Role for "${name}" (optional)`,
        initialValue: remembered?.role ?? '',
        placeholder: 'product, reviewer…',
      })
    ).trim()

    const githubLogin = assertNotCancel(
      await p.text({
        message: `GitHub login for "${name}" (optional)`,
        initialValue: remembered?.githubLogin ?? '',
        placeholder: 'Needed only for PR-review routes',
      })
    ).trim()

    const avatarUrl = assertNotCancel(
      await p.text({
        message: `Avatar image URL for "${name}" (optional)`,
        initialValue: remembered?.avatarUrl ?? '',
        placeholder: 'Shown beside this agent’s Slack notifications',
      })
    ).trim()

    return {
      name,
      apiKey,
      enabled: true,
      ...(role ? { role } : {}),
      ...(githubLogin ? { githubLogin } : {}),
      ...(avatarUrl ? { avatarUrl } : {}),
    }
  }

  const profiles: HermesProfileConfig[] = []

  if (install && install.profiles.length > 0) {
    p.log.step(`Found ${install.profiles.length} profile(s)`)

    for (const discovered of install.profiles) {
      const label = discovered.apiKey
        ? `Add "${discovered.name}"?`
        : `Add "${discovered.name}"? (no API_SERVER_KEY found in its .env)`

      const include = assertNotCancel(
        await p.confirm({ message: label, initialValue: Boolean(discovered.apiKey) })
      )
      if (!include) {
        continue
      }

      const profile = await configureProfile(discovered.name, discovered)
      if (profile) {
        profiles.push(profile)
      }
    }
  }

  // Always allow adding one by hand: a profile can live on another host, and
  // discovery finding nothing must not be a dead end.
  for (;;) {
    const prompt =
      profiles.length === 0
        ? 'No profiles added yet. Add one by name?'
        : 'Add another profile by name?'
    const more = assertNotCancel(
      await p.confirm({ message: prompt, initialValue: profiles.length === 0 })
    )
    if (!more) {
      break
    }

    const name = assertNotCancel(await requiredText('Profile name')).trim()
    if (profiles.some((profile) => profile.name === name)) {
      p.log.warn(`"${name}" was already added.`)
      continue
    }

    const profile = await configureProfile(name)
    if (profile) {
      profiles.push(profile)
    }
  }

  if (profiles.length === 0) {
    p.cancel('No Hermes profiles configured; there would be nothing to dispatch to.')
    return
  }

  /*
   * ── Secrets ──────────────────────────────────────────────
   *
   * Tracker credentials belong in the cloud now, under Settings →
   * Integrations: one place for the whole organization, encrypted at rest, and
   * the only way the dashboard can offer a repository picker. What stays here
   * is a *fallback*, for the two cases the cloud cannot serve -- a runner with
   * no control plane, and a runner restarting while the cloud is unreachable.
   *
   * So this asks once, and only if the operator says they want one.
   */
  const secrets = { ...existing.secrets }
  const wantsLocalTokens = assertNotCancel(
    await p.confirm({
      message: 'Store tracker credentials on this machine as a fallback?',
      initialValue: false,
    })
  )
  if (wantsLocalTokens) {
    const githubToken = assertNotCancel(
      await p.password({ message: 'GitHub token (blank to skip)' })
    )
    if (githubToken?.trim()) {
      secrets.GITHUB_TOKEN = githubToken.trim()
    }

    const linearKey = assertNotCancel(
      await p.password({ message: 'Linear API key (blank to skip)' })
    )
    if (linearKey?.trim()) {
      secrets.LINEAR_API_KEY = linearKey.trim()
    }
  }

  const config: StoredConfig = {
    version: CONFIG_VERSION,
    cloud: { baseUrl: cloudBaseUrl.replace(/\/+$/, ''), apiKey: cloudApiKey, runnerName },
    hermes: { baseUrl: hermesBaseUrl.replace(/\/+$/, ''), profiles },
    // Projects and routes are cloud-side configuration; the runner pulls them.
    projects: existing.projects,
    secrets,
    updatedAt: Date.now(),
  }

  p.note(
    [
      `Cloud:    ${config.cloud!.baseUrl}  (runner "${runnerName}")`,
      `Hermes:   ${config.hermes!.baseUrl}`,
      `Profiles: ${profiles.map((profile) => profile.name).join(', ')}`,
    ].join('\n'),
    'Configuration'
  )

  const confirmed = assertNotCancel(
    await p.confirm({ message: 'Save to ~/.sentinel0/config.json?', initialValue: true })
  )
  if (!confirmed) {
    p.cancel('Nothing was written.')
    return
  }

  await context.saveStoredConfig(config)

  p.outro(
    [
      BRAND('Saved.'),
      '',
      'Next:',
      '  sentinel0 preflight        check this machine can reach everything',
      '  sentinel0 start            run the orchestrator',
      '  sentinel0 runner install   keep it running across reboots',
    ].join('\n')
  )
}
