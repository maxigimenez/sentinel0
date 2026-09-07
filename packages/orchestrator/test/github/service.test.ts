import { describe, expect, it } from 'vitest'
import { TICKET_PROVIDER, TRIGGER_TYPE, type ProjectConfig } from '@sentinel0/common'
import type { GitHubRestClient } from '@sentinel0/common/github'
import { GitHubService, parseIssueNumber, requireRepo, splitRef } from '../../src/github/service.js'

const project: ProjectConfig = {
  id: 'acme/platform',
  provider: TICKET_PROVIDER.GITHUB,
  filters: { owner: 'acme', repo: 'platform' },
}

/** Only the methods a given test exercises; the rest throw if reached. */
function fakeApi(overrides: Partial<GitHubRestClient>): GitHubRestClient {
  return {
    issues: async () => [],
    pullRequests: async () => [],
    createComment: async () => undefined,
    ensureLabel: async () => undefined,
    addLabels: async () => undefined,
    removeLabel: async () => undefined,
    ...overrides,
  } as unknown as GitHubRestClient
}

describe('collect', () => {
  it('maps GitHub’s snake_case onto the trigger event', async () => {
    const service = new GitHubService(
      fakeApi({
        issues: async () => [
          {
            number: 12,
            title: 'Billing export is wrong',
            body: 'Numbers do not add up.',
            html_url: 'https://github.com/acme/platform/issues/12',
            state: 'open',
            updated_at: '2026-09-01T10:00:00Z',
            labels: [{ name: 'bug' }],
            assignees: [{ login: 'maxi' }],
          },
        ],
      })
    )

    const [event] = await service.collect(project)
    expect(event).toMatchObject({
      type: TRIGGER_TYPE.TICKET,
      ref: 'acme/platform#12',
      revision: '2026-09-01T10:00:00Z',
      url: 'https://github.com/acme/platform/issues/12',
      labels: ['bug'],
      assignees: ['maxi'],
    })
  })

  const pull = (overrides: Record<string, unknown> = {}) => ({
    number: 42,
    title: 'Fix the export',
    body: '',
    html_url: 'https://github.com/acme/platform/pull/42',
    state: 'open',
    updated_at: '2026-09-01T10:00:00Z',
    draft: false,
    labels: [],
    assignees: [],
    requested_reviewers: [],
    requested_teams: [],
    base: { ref: 'main' },
    ...overrides,
  })

  /*
   * `gh` reported users and teams in one `reviewRequests` array; the REST API
   * splits them. Dropping the teams half would make a route targeting a
   * review-owning team silently never match.
   */
  it('merges requested users and requested teams into one reviewer list', async () => {
    const service = new GitHubService(
      fakeApi({
        pullRequests: async () => [
          pull({
            requested_reviewers: [{ login: 'maxi' }],
            requested_teams: [{ slug: 'platform-reviewers' }],
          }),
        ],
      })
    )

    const events = await service.collect(project)
    const review = events.find((event) => event.type === TRIGGER_TYPE.PR_REVIEW_REQUESTED)
    expect(review?.requestedReviewers).toEqual(['maxi', 'platform-reviewers'])
  })

  it('emits a pr_event for every open pull request, reviewed or not', async () => {
    const service = new GitHubService(fakeApi({ pullRequests: async () => [pull()] }))
    const events = await service.collect(project)
    expect(events.map((event) => event.type)).toEqual([TRIGGER_TYPE.PR_EVENT])
  })

  it('reads draft and base branch from their REST names', async () => {
    const service = new GitHubService(
      fakeApi({ pullRequests: async () => [pull({ draft: true, base: { ref: 'release' } })] })
    )
    const [event] = await service.collect(project)
    expect(event.isDraft).toBe(true)
    expect(event.baseBranch).toBe('release')
  })

  /*
   * Reviewer and assignee changes do not reliably move `updated_at`, so they
   * are folded into the revision. Without that, requesting a review on an
   * otherwise-unchanged pull request would never re-trigger.
   */
  it('folds reviewers, assignees and labels into the pr_event revision', async () => {
    const service = new GitHubService(
      fakeApi({
        pullRequests: async () => [
          pull({ assignees: [{ login: 'maxi' }], labels: [{ name: 'urgent' }] }),
        ],
      })
    )
    const [event] = await service.collect(project)
    expect(event.revision).toBe('2026-09-01T10:00:00Z|maxi||urgent')
  })

  it('ignores a project that is not a GitHub one', async () => {
    const service = new GitHubService(
      fakeApi({
        issues: async () => {
          throw new Error('should not be called')
        },
      })
    )
    expect(await service.collect({ ...project, provider: TICKET_PROVIDER.LINEAR })).toEqual([])
  })
})

describe('updateLabels', () => {
  const event = {
    type: TRIGGER_TYPE.TICKET,
    projectId: 'acme/platform',
    provider: TICKET_PROVIDER.GITHUB,
    ref: 'acme/platform#12',
    revision: 'r',
    title: 't',
  } as never

  it('creates each label before applying it, and adds them in one call', async () => {
    const ensured: string[] = []
    const added: string[][] = []
    const service = new GitHubService(
      fakeApi({
        ensureLabel: async (_o: string, _r: string, name: string) => void ensured.push(name),
        addLabels: async (_o: string, _r: string, _n: number, labels: string[]) =>
          void added.push(labels),
      })
    )

    await service.updateLabels(event, { add: ['sentinel0:done', 'reviewed'] })
    // Adding an unknown label fails outright, which would silently break the
    // marker-based loop guard on a repository that has not seen them before.
    expect(ensured).toEqual(['sentinel0:done', 'reviewed'])
    expect(added).toEqual([['sentinel0:done', 'reviewed']])
  })

  it('removes one label per call, since GitHub has no batch form', async () => {
    const removed: string[] = []
    const service = new GitHubService(
      fakeApi({
        removeLabel: async (_o: string, _r: string, _n: number, label: string) =>
          void removed.push(label),
      })
    )
    await service.updateLabels(event, { remove: ['sentinel0:in-progress', 'stale'] })
    expect(removed).toEqual(['sentinel0:in-progress', 'stale'])
  })

  it('does nothing at all when both lists are empty', async () => {
    let touched = false
    const service = new GitHubService(
      fakeApi({
        ensureLabel: async () => void (touched = true),
        addLabels: async () => void (touched = true),
        removeLabel: async () => void (touched = true),
      })
    )
    await service.updateLabels(event, {})
    expect(touched).toBe(false)
  })
})

describe('refs', () => {
  it('round-trips owner, repo and number', () => {
    expect(splitRef('acme/platform#12')).toEqual({ owner: 'acme', repo: 'platform' })
    expect(parseIssueNumber('acme/platform#12')).toBe(12)
  })

  it('rejects a malformed ref rather than guessing', () => {
    expect(() => splitRef('platform#12')).toThrow(/Malformed/)
    expect(() => parseIssueNumber('acme/platform')).toThrow(/Unable to parse/)
  })

  it('insists on both halves of the repository being configured', () => {
    expect(() => requireRepo({ ...project, filters: { owner: 'acme' } })).toThrow(
      /filters.owner and filters.repo/
    )
  })
})
