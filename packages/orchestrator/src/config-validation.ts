import {
  TICKET_PROVIDER,
  isRepositorySlug,
  type CloudConfig,
  type HermesConfig,
  type HermesProfileConfig,
  type ProjectConfig,
  type StoredConfig,
  type TicketProvider,
} from '@sentinel0/common'

const ALLOWED_TICKET_PROVIDERS = [TICKET_PROVIDER.LINEAR, TICKET_PROVIDER.GITHUB] as const

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`)
  }
}

function assertNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`)
  }
  return value.trim()
}

function assertOptionalString(value: unknown, label: string): string | undefined {
  return value === undefined || value === null ? undefined : assertNonEmptyString(value, label)
}

function assertHttpUrl(value: unknown, label: string): string {
  const raw = assertNonEmptyString(value, label)
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`${label} must be a valid URL (got "${raw}").`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${label} must use http or https (got "${parsed.protocol}").`)
  }
  return raw.replace(/\/+$/, '')
}

export function validateHermesProfile(raw: unknown, index: number): HermesProfileConfig {
  assertObject(raw, `hermes.profiles[${index}]`)

  const name = assertNonEmptyString(raw.name, `hermes.profiles[${index}].name`)

  // Under gateway.multiplex_profiles every named profile needs its own key --
  // the default profile's key is rejected on /p/<profile> routes -- so an
  // absent key is a guaranteed 401 later. Catch it at config load instead.
  const apiKey = assertNonEmptyString(raw.apiKey, `hermes.profiles[${index}].apiKey ("${name}")`)

  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    throw new Error(`hermes.profiles[${index}].enabled ("${name}") must be a boolean.`)
  }

  const linearUserId = assertOptionalString(
    raw.linearUserId,
    `hermes.profiles[${index}].linearUserId`
  )
  const linearWorkspaceId = assertOptionalString(
    raw.linearWorkspaceId,
    `hermes.profiles[${index}].linearWorkspaceId`
  )
  if (Boolean(linearUserId) !== Boolean(linearWorkspaceId)) {
    throw new Error(`Profile "${name}" needs both linearUserId and linearWorkspaceId.`)
  }

  return {
    name,
    apiKey,
    githubLogin: assertOptionalString(raw.githubLogin, `hermes.profiles[${index}].githubLogin`),
    linearUserId,
    linearWorkspaceId,
    role: assertOptionalString(raw.role, `hermes.profiles[${index}].role`),
    avatarUrl: assertOptionalString(raw.avatarUrl, `hermes.profiles[${index}].avatarUrl`),
    enabled: raw.enabled !== false,
  }
}

export function validateHermes(raw: unknown): HermesConfig {
  assertObject(raw, 'hermes')

  const baseUrl = assertHttpUrl(raw.baseUrl, 'hermes.baseUrl')

  if (!Array.isArray(raw.profiles) || raw.profiles.length === 0) {
    throw new Error('hermes.profiles must be a non-empty array.')
  }

  const seen = new Set<string>()
  const profiles = raw.profiles.map((entry, index) => {
    const profile = validateHermesProfile(entry, index)
    if (seen.has(profile.name)) {
      throw new Error(`Duplicate hermes profile "${profile.name}".`)
    }
    seen.add(profile.name)
    return profile
  })

  return { baseUrl, profiles }
}

export function validateCloud(raw: unknown): CloudConfig {
  assertObject(raw, 'cloud')
  return {
    baseUrl: assertHttpUrl(raw.baseUrl, 'cloud.baseUrl'),
    apiKey: assertNonEmptyString(raw.apiKey, 'cloud.apiKey'),
    runnerName: assertNonEmptyString(raw.runnerName, 'cloud.runnerName'),
  }
}

export function validateProject(raw: unknown): ProjectConfig {
  assertObject(raw, 'project')

  const id = assertNonEmptyString(raw.id, 'project.id')

  const provider = assertNonEmptyString(raw.provider, `project.provider for "${id}"`)
  if (!ALLOWED_TICKET_PROVIDERS.includes(provider as TicketProvider)) {
    throw new Error(
      `Unsupported ticket provider "${provider}" for project "${id}". Supported: ${ALLOWED_TICKET_PROVIDERS.join(', ')}.`
    )
  }

  const filtersRaw = raw.filters
  assertObject(filtersRaw, `project.filters for "${id}"`)
  const filters = filtersRaw as ProjectConfig['filters']
  if (filters.repository !== undefined && !isRepositorySlug(filters.repository)) {
    throw new Error(`project.filters.repository for "${id}" must be a GitHub owner/repo.`)
  }

  if (provider === TICKET_PROVIDER.GITHUB) {
    assertNonEmptyString(filters.owner, `project.filters.owner for "${id}"`)
    assertNonEmptyString(filters.repo, `project.filters.repo for "${id}"`)
  }
  if (provider === TICKET_PROVIDER.LINEAR) {
    assertNonEmptyString(filters.team, `project.filters.team for "${id}"`)
  }

  return { id, provider: provider as TicketProvider, filters }
}

export interface ValidatedConfig {
  projects: ProjectConfig[]
  hermes: HermesConfig | null
  cloud: CloudConfig | null
}

export function validateStoredConfig(stored: StoredConfig): ValidatedConfig {
  const projectIds = new Set<string>()
  const projects: ProjectConfig[] = []

  for (const raw of stored.projects) {
    const project = validateProject(raw)
    if (projectIds.has(project.id)) {
      throw new Error(`Duplicate project id "${project.id}".`)
    }
    projectIds.add(project.id)
    projects.push(project)
  }

  return {
    projects,
    hermes: stored.hermes ? validateHermes(stored.hermes) : null,
    cloud: stored.cloud ? validateCloud(stored.cloud) : null,
  }
}
