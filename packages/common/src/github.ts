/**
 * GitHub's REST API, over `fetch`, with a token supplied per call.
 *
 * This replaces the `gh` subprocess the service used to shell out to. `gh` was
 * never a dependency worth having here -- it required a binary and an
 * interactive `gh auth login` on the runner's machine, which is exactly what
 * stopped working -- and the six calls Sentinel0 actually makes are plain REST.
 *
 * The token arrives through a **provider function**, not a constructor value.
 * A personal access token is a constant and would not need one, but a GitHub
 * App installation token expires roughly hourly, and a provider is the one
 * shape that serves both. Nothing else in this file would change to move from
 * one to the other.
 */

const API_ROOT = 'https://api.github.com'

/** GitHub pins its REST schema by header; unset means "whatever is current". */
const API_VERSION = '2022-11-28'

/** The largest page GitHub serves, and what `gh --limit 100` asked for. */
export const PAGE_SIZE = 100

export type TokenProvider = () => Promise<string>

export interface GitHubUser {
  login: string
}

export interface GitHubLabel {
  name: string
}

export interface GitHubIssue {
  number: number
  title: string
  body: string | null
  html_url: string
  state: string
  updated_at: string
  labels: GitHubLabel[]
  assignees: GitHubUser[]
  /**
   * Present only on pull requests.
   *
   * `GET /issues` returns pull requests as well as issues -- `gh issue list`
   * filtered them out and the raw endpoint does not. Without this discriminator
   * every open pull request would also raise a `ticket` trigger, so a route
   * keyed on tickets would fire against pull requests it was never meant to
   * see.
   */
  pull_request?: unknown
}

export interface GitHubPullRequest {
  number: number
  title: string
  body: string | null
  html_url: string
  state: string
  updated_at: string
  draft: boolean
  labels: GitHubLabel[]
  assignees: GitHubUser[]
  requested_reviewers: GitHubUser[]
  requested_teams: Array<{ slug: string }>
  base: { ref: string }
}

/** What a token turns out to be, once asked. */
export interface GitHubIdentity {
  login: string
  scopes: string[]
}

/**
 * An error carrying GitHub's status, so callers can tell apart the cases that
 * need different handling: 401 means the token is wrong, 403 with a rate-limit
 * header means wait, 404 on a label removal means it was already gone.
 */
export class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    message: string
  ) {
    super(`GitHub ${method} ${path} failed (${status}): ${message}`)
    this.name = 'GitHubApiError'
  }
}

interface RequestOptions {
  query?: Record<string, string | number | undefined>
  body?: unknown
  /** Statuses to resolve as `undefined` rather than throw. */
  tolerate?: number[]
}

export class GitHubRestClient {
  constructor(
    private readonly token: TokenProvider,
    private readonly root: string = API_ROOT
  ) {}

  private async request<T>(
    method: string,
    path: string,
    options: RequestOptions = {}
  ): Promise<T | undefined> {
    const url = new URL(`${this.root}${path}`)
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value))
      }
    }

    const response = await fetch(url, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${await this.token()}`,
        'x-github-api-version': API_VERSION,
        'user-agent': 'sentinel0',
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    })

    if (options.tolerate?.includes(response.status)) {
      return undefined
    }

    if (!response.ok) {
      throw new GitHubApiError(response.status, method, path, await describe(response))
    }

    // 204 on a successful DELETE, and an empty body is not JSON.
    if (response.status === 204) {
      return undefined
    }
    return (await response.json()) as T
  }

  /**
   * Who the token is, and what it may do.
   *
   * Used by preflight and by the cloud when a credential is saved: a token
   * that cannot answer this is not worth storing, and the scope list is what
   * turns "GitHub rejected that" into a message naming the missing permission.
   */
  async identity(): Promise<GitHubIdentity> {
    const url = new URL(`${this.root}/user`)
    const response = await fetch(url, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${await this.token()}`,
        'x-github-api-version': API_VERSION,
        'user-agent': 'sentinel0',
      },
    })
    if (!response.ok) {
      throw new GitHubApiError(response.status, 'GET', '/user', await describe(response))
    }
    const user = (await response.json()) as GitHubUser

    // Classic tokens report their grants in a header; fine-grained tokens send
    // no such header at all, and an empty list means "unknown", not "none".
    const scopes = (response.headers.get('x-oauth-scopes') ?? '')
      .split(',')
      .map((scope) => scope.trim())
      .filter(Boolean)

    return { login: user.login, scopes }
  }

  /**
   * Repositories the token can reach, most recently pushed first.
   *
   * This exists for the dashboard's project picker. It asks for everything the
   * token can see rather than one owner's, because an operator's token
   * routinely spans a personal account and one or more organizations, and
   * making them type the slug correctly was the failure this replaces.
   */
  async repositories(perPage = PAGE_SIZE): Promise<Array<{ full_name: string; private: boolean }>> {
    return (
      (await this.request<Array<{ full_name: string; private: boolean }>>('GET', '/user/repos', {
        query: {
          per_page: perPage,
          sort: 'pushed',
          affiliation: 'owner,collaborator,organization_member',
        },
      })) ?? []
    )
  }

  async labels(owner: string, repo: string, perPage = PAGE_SIZE): Promise<GitHubLabel[]> {
    return (
      (await this.request<GitHubLabel[]>('GET', `/repos/${owner}/${repo}/labels`, {
        query: { per_page: perPage },
      })) ?? []
    )
  }

  /**
   * Open issues, with pull requests removed.
   *
   * `labels` is comma-separated and GitHub ANDs it, which is the same
   * narrowing `gh`'s repeated `--label` gave: a coarse pre-filter, with the
   * real matching left to the routes.
   */
  async issues(
    owner: string,
    repo: string,
    filters: { state?: string; labels?: string[] } = {}
  ): Promise<GitHubIssue[]> {
    const issues =
      (await this.request<GitHubIssue[]>('GET', `/repos/${owner}/${repo}/issues`, {
        query: {
          state: filters.state ?? 'open',
          per_page: PAGE_SIZE,
          labels: filters.labels?.length ? filters.labels.join(',') : undefined,
        },
      })) ?? []

    return issues.filter((issue) => issue.pull_request === undefined)
  }

  async pullRequests(owner: string, repo: string): Promise<GitHubPullRequest[]> {
    return (
      (await this.request<GitHubPullRequest[]>('GET', `/repos/${owner}/${repo}/pulls`, {
        query: { state: 'open', per_page: PAGE_SIZE },
      })) ?? []
    )
  }

  async createComment(owner: string, repo: string, number: number, body: string): Promise<void> {
    await this.request('POST', `/repos/${owner}/${repo}/issues/${number}/comments`, {
      body: { body },
    })
  }

  /**
   * Creates a label, treating "it already exists" as success.
   *
   * Adding an unknown label to an issue fails outright, so the `sentinel0:`
   * markers would never apply to a repository that has not seen them -- and
   * the loop guard that depends on them would quietly stop working.
   */
  async ensureLabel(
    owner: string,
    repo: string,
    name: string,
    color: string,
    description: string
  ): Promise<void> {
    await this.request('POST', `/repos/${owner}/${repo}/labels`, {
      body: { name, color, description },
      // 422 is what GitHub returns for a name already in use.
      tolerate: [422],
    })
  }

  async addLabels(owner: string, repo: string, number: number, labels: string[]): Promise<void> {
    if (labels.length === 0) {
      return
    }
    await this.request('POST', `/repos/${owner}/${repo}/issues/${number}/labels`, {
      body: { labels },
    })
  }

  /**
   * Removes one label, treating "it was not there" as success.
   *
   * The in-progress marker is cleared on every terminal path, including ones
   * where a human already took it off by hand. A 404 there is the expected
   * end state, not a failure worth reporting.
   */
  async removeLabel(owner: string, repo: string, number: number, label: string): Promise<void> {
    await this.request(
      'DELETE',
      `/repos/${owner}/${repo}/issues/${number}/labels/${encodeURIComponent(label)}`,
      { tolerate: [404] }
    )
  }
}

/** GitHub's own error message when it sends one, and the status text otherwise. */
async function describe(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string; errors?: unknown }
    return body.message ?? response.statusText
  } catch {
    return response.statusText
  }
}
