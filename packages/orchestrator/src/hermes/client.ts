import type { ApprovalChoice } from '@sentinel0/common'
import type {
  HermesCapabilities,
  HermesCreateRunRequest,
  HermesCreateRunResponse,
  HermesModel,
  HermesRunState,
  HermesSkill,
  HermesStreamEvent,
  HermesToolset,
} from './types.js'

export class HermesApiError extends Error {
  constructor(
    readonly status: number,
    readonly profile: string,
    readonly path: string,
    body: string
  ) {
    super(`Hermes ${status} on profile "${profile}" at ${path}: ${truncate(body, 400)}`)
    this.name = 'HermesApiError'
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

export interface HermesClientOptions {
  /** Gateway root, e.g. http://127.0.0.1:8642 — no trailing slash required. */
  baseUrl: string
  /** Hermes profile name. `default` uses unprefixed routes. */
  profile: string
  /**
   * That profile's own API_SERVER_KEY. Under `gateway.multiplex_profiles`, the
   * default profile's key is rejected on `/p/<profile>/…` prefixes, so each
   * profile must carry its own.
   */
  apiKey: string
  requestTimeoutMs?: number
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

/**
 * Typed client for one Hermes profile's API server.
 *
 * One instance addresses exactly one profile: the URL prefix and the bearer key
 * are bound together at construction, which makes it impossible to accidentally
 * present the default profile's key to a named profile's routes.
 */
export class HermesClient {
  private readonly root: string
  private readonly prefix: string
  private readonly requestTimeoutMs: number

  constructor(private readonly options: HermesClientOptions) {
    if (!options.baseUrl) {
      throw new Error('Hermes baseUrl is required.')
    }
    if (!options.apiKey) {
      throw new Error(`Hermes API key is required for profile "${options.profile}".`)
    }

    this.root = options.baseUrl.replace(/\/+$/, '')
    this.prefix = options.profile === 'default' ? '' : `/p/${options.profile}`
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  }

  get profile(): string {
    return this.options.profile
  }

  private url(path: string): string {
    return `${this.root}${this.prefix}${path}`
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      authorization: `Bearer ${this.options.apiKey}`,
      ...extra,
    }
  }

  private async request<T>(
    path: string,
    init: RequestInit & { signal?: AbortSignal } = {}
  ): Promise<T> {
    const timeout = AbortSignal.timeout(this.requestTimeoutMs)
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout

    const response = await fetch(this.url(path), {
      ...init,
      signal,
      headers: this.headers(init.headers as Record<string, string> | undefined),
    })

    if (!response.ok) {
      throw new HermesApiError(
        response.status,
        this.options.profile,
        path,
        await response.text().catch(() => '')
      )
    }

    if (response.status === 204) {
      return undefined as T
    }

    return (await response.json()) as T
  }

  private async postJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    return this.request<T>(path, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
      signal,
    })
  }

  // ── Discovery ──────────────────────────────────────────────

  async capabilities(): Promise<HermesCapabilities> {
    return this.request<HermesCapabilities>('/v1/capabilities')
  }

  async models(): Promise<HermesModel[]> {
    const payload = await this.request<{ data?: HermesModel[] } | HermesModel[]>('/v1/models')
    return Array.isArray(payload) ? payload : (payload.data ?? [])
  }

  async skills(): Promise<HermesSkill[]> {
    const payload = await this.request<HermesSkill[] | { data?: HermesSkill[] }>('/v1/skills')
    return Array.isArray(payload) ? payload : (payload.data ?? [])
  }

  async toolsets(): Promise<HermesToolset[]> {
    const payload = await this.request<HermesToolset[] | { data?: HermesToolset[] }>('/v1/toolsets')
    return Array.isArray(payload) ? payload : (payload.data ?? [])
  }

  // ── Runs ───────────────────────────────────────────────────

  async createRun(
    body: HermesCreateRunRequest,
    signal?: AbortSignal
  ): Promise<HermesCreateRunResponse> {
    return this.postJson<HermesCreateRunResponse>('/v1/runs', body, signal)
  }

  async getRun(runId: string, signal?: AbortSignal): Promise<HermesRunState> {
    return this.request<HermesRunState>(`/v1/runs/${encodeURIComponent(runId)}`, { signal })
  }

  async stopRun(runId: string): Promise<void> {
    await this.postJson<unknown>(`/v1/runs/${encodeURIComponent(runId)}/stop`, {})
  }

  /**
   * Answer a pending approval gate.
   *
   * The body is `{choice}` and the vocabulary is Hermes': `once`, `session`,
   * `always`, `deny`. Anything else comes back as `invalid_approval_choice`,
   * and answering a run whose gate has already lapsed comes back as
   * `approval_not_pending` -- which is what a run abandoned by the poller looks
   * like from the outside.
   */
  async resolveApproval(runId: string, choice: ApprovalChoice): Promise<void> {
    await this.postJson<unknown>(`/v1/runs/${encodeURIComponent(runId)}/approval`, { choice })
  }

  /**
   * Consume the SSE progress stream for a run.
   *
   * Progress only — never completion. Hermes expires run event buffers after
   * five minutes, so a stream that ends says nothing about whether the run
   * finished; `HermesAdapter` polls `getRun` for that. Callers should treat a
   * returning generator as "no more progress available", not "run over".
   */
  async *streamRunEvents(
    runId: string,
    signal?: AbortSignal
  ): AsyncGenerator<HermesStreamEvent, void, void> {
    const response = await fetch(this.url(`/v1/runs/${encodeURIComponent(runId)}/events`), {
      headers: this.headers({ accept: 'text/event-stream' }),
      signal,
    })

    if (!response.ok) {
      throw new HermesApiError(
        response.status,
        this.options.profile,
        `/v1/runs/${runId}/events`,
        await response.text().catch(() => '')
      )
    }

    if (!response.body) {
      return
    }

    const decoder = new TextDecoder()
    let buffer = ''

    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true })

      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const parsed = parseSseFrame(frame)
        if (parsed) {
          yield parsed
        }
        boundary = buffer.indexOf('\n\n')
      }
    }

    const trailing = parseSseFrame(buffer)
    if (trailing) {
      yield trailing
    }
  }
}

/**
 * Decode one SSE frame. Returns null for comments, keep-alives, and the
 * `[DONE]` sentinel. Multi-line `data:` fields are joined with newlines per the
 * SSE spec; a data payload that is not JSON is surfaced as a raw string rather
 * than dropped, so unexpected Hermes output still reaches the logs.
 */
export function parseSseFrame(frame: string): HermesStreamEvent | null {
  const trimmed = frame.trim()
  if (!trimmed || trimmed.startsWith(':')) {
    return null
  }

  let event = 'message'
  const dataLines: string[] = []

  for (const line of trimmed.split('\n')) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim()
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''))
    }
  }

  if (dataLines.length === 0) {
    return null
  }

  const raw = dataLines.join('\n')
  if (raw === '[DONE]') {
    return null
  }

  try {
    return { event, data: JSON.parse(raw) }
  } catch {
    return { event, data: raw }
  }
}
