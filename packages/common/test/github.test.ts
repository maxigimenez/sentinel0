import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitHubApiError, GitHubRestClient } from '../src/github.js'

/** Captures what the client sent, and replies with what the test dictates. */
function stubFetch(
  responder: (
    url: URL,
    init: RequestInit
  ) => { status?: number; body?: unknown; headers?: Record<string, string> }
) {
  const calls: Array<{ url: URL; init: RequestInit }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const url = new URL(String(input))
      calls.push({ url, init })
      const { status = 200, body = {}, headers = {} } = responder(url, init)
      return new Response(status === 204 ? null : JSON.stringify(body), { status, headers })
    })
  )
  return calls
}

afterEach(() => vi.unstubAllGlobals())

const client = (responder: Parameters<typeof stubFetch>[0]) => {
  const calls = stubFetch(responder)
  return { api: new GitHubRestClient(async () => 'ghp_test'), calls }
}

describe('authentication', () => {
  it('presents the token the provider returns, each time it is asked', async () => {
    const calls: string[] = []
    let nth = 0
    stubFetch(() => ({ body: [] }))
    const api = new GitHubRestClient(async () => `token_${++nth}`)

    await api.issues('acme', 'platform')
    await api.issues('acme', 'platform')

    const fetchMock = fetch as unknown as { mock: { calls: Array<[unknown, RequestInit]> } }
    for (const [, init] of fetchMock.mock.calls) {
      calls.push((init.headers as Record<string, string>).authorization)
    }
    // Not cached at construction: a rotated credential, or an expired App
    // installation token, must be picked up by the next request.
    expect(calls).toEqual(['Bearer token_1', 'Bearer token_2'])
  })
})

describe('issues', () => {
  /*
   * The single most important line in this file.
   *
   * `GET /issues` returns pull requests too; `gh issue list` did not. Without
   * the filter every open pull request would also raise a `ticket` trigger,
   * and a route keyed on tickets would fire against pull requests it was never
   * meant to see.
   */
  it('excludes pull requests, which the raw endpoint includes', async () => {
    const { api } = client(() => ({
      body: [
        { number: 1, title: 'A real issue', labels: [], assignees: [] },
        {
          number: 2,
          title: 'A pull request',
          labels: [],
          assignees: [],
          pull_request: { url: 'x' },
        },
      ],
    }))

    const issues = await api.issues('acme', 'platform')
    expect(issues.map((issue) => issue.number)).toEqual([1])
  })

  it('ANDs labels the way the repeated gh flag did', async () => {
    const { api, calls } = client(() => ({ body: [] }))
    await api.issues('acme', 'platform', { state: 'closed', labels: ['bug', 'p1'] })

    expect(calls[0].url.pathname).toBe('/repos/acme/platform/issues')
    expect(calls[0].url.searchParams.get('labels')).toBe('bug,p1')
    expect(calls[0].url.searchParams.get('state')).toBe('closed')
  })

  it('omits the label filter entirely when there is none', async () => {
    const { api, calls } = client(() => ({ body: [] }))
    await api.issues('acme', 'platform')
    // An empty `labels=` is not the same request: GitHub reads it as a filter.
    expect(calls[0].url.searchParams.has('labels')).toBe(false)
    expect(calls[0].url.searchParams.get('state')).toBe('open')
  })
})

describe('labels', () => {
  it('treats an already-existing label as success', async () => {
    const { api } = client(() => ({ status: 422, body: { message: 'already_exists' } }))
    await expect(
      api.ensureLabel('acme', 'platform', 'sentinel0:in-progress', 'f97316', 'Managed')
    ).resolves.toBeUndefined()
  })

  it('still reports a real failure when creating a label', async () => {
    const { api } = client(() => ({ status: 403, body: { message: 'Resource not accessible' } }))
    await expect(
      api.ensureLabel('acme', 'platform', 'sentinel0:done', 'f97316', 'Managed')
    ).rejects.toThrow(/403.*Resource not accessible/)
  })

  /*
   * The in-progress marker is cleared on every terminal path, including ones
   * where a human already removed it by hand. A 404 there is the expected end
   * state, and treating it as a failure would log an error on a healthy run.
   */
  it('treats removing an absent label as success', async () => {
    const { api } = client(() => ({ status: 404, body: { message: 'Label does not exist' } }))
    await expect(
      api.removeLabel('acme', 'platform', 7, 'sentinel0:in-progress')
    ).resolves.toBeUndefined()
  })

  it('escapes a label name into the path', async () => {
    const { api, calls } = client(() => ({ status: 204 }))
    await api.removeLabel('acme', 'platform', 7, 'needs triage/urgent')
    expect(calls[0].url.pathname).toBe(
      '/repos/acme/platform/issues/7/labels/needs%20triage%2Furgent'
    )
  })

  it('does not call GitHub at all when there is nothing to add', async () => {
    const { api, calls } = client(() => ({ body: {} }))
    await api.addLabels('acme', 'platform', 7, [])
    expect(calls).toHaveLength(0)
  })
})

describe('identity', () => {
  it('reports the login and the classic token scopes', async () => {
    const { api } = client(() => ({
      body: { login: 'sentinel0-bot' },
      headers: { 'x-oauth-scopes': 'repo, read:org' },
    }))
    expect(await api.identity()).toEqual({ login: 'sentinel0-bot', scopes: ['repo', 'read:org'] })
  })

  /*
   * Fine-grained tokens send no scope header. An empty list means "not
   * reported", not "no permissions", so nothing may treat it as a denial.
   */
  it('reports no scopes for a fine-grained token rather than failing', async () => {
    const { api } = client(() => ({ body: { login: 'sentinel0-bot' } }))
    expect(await api.identity()).toEqual({ login: 'sentinel0-bot', scopes: [] })
  })

  it('carries GitHub’s own message out of a rejection', async () => {
    const { api } = client(() => ({ status: 401, body: { message: 'Bad credentials' } }))
    await expect(api.identity()).rejects.toThrow(GitHubApiError)
    await expect(api.identity()).rejects.toThrow(/401.*Bad credentials/)
  })
})

describe('requests', () => {
  it('pins the API version and identifies itself', async () => {
    const { api, calls } = client(() => ({ body: [] }))
    await api.pullRequests('acme', 'platform')
    const headers = calls[0].init.headers as Record<string, string>
    expect(headers['x-github-api-version']).toBe('2022-11-28')
    expect(headers['user-agent']).toBe('sentinel0')
    expect(headers.accept).toBe('application/vnd.github+json')
  })

  it('survives an error body that is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>502 Bad Gateway</html>', { status: 502 }))
    )
    const api = new GitHubRestClient(async () => 'ghp_test')
    await expect(api.issues('acme', 'platform')).rejects.toThrow(/502/)
  })
})
