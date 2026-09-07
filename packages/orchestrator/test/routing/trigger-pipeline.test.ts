import { describe, expect, it } from 'vitest'
import {
  TICKET_PROVIDER,
  TRIGGER_TYPE,
  type ProjectConfig,
  type RoutingRule,
  type TriggerEvent,
} from '@sentinel0/common'
import type { GitHubRestClient } from '@sentinel0/common/github'
import { GitHubService } from '../../src/github/service.js'
import { openDatabase, type Sentinel0Database } from '../../src/database.js'
import { explainRule, matchesRule } from '../../src/routing/rule-engine.js'
import { observeCycle } from '../../src/triggers/history.js'

/**
 * Collection, observation and matching wired together exactly as the poll loop
 * wires them.
 *
 * The unit tests hand `changes` to the rule engine directly, which is what let
 * a dead route ship: a `reviewersAdded` rule on `pr_review_requested` passed
 * every one of them while being structurally unable to fire against real
 * GitHub data, because that trigger type is only emitted once a reviewer
 * exists and so had no prior sighting to compare against.
 */

const project: ProjectConfig = {
  id: 'trackside',
  provider: TICKET_PROVIDER.GITHUB,
  filters: { owner: 'acme', repo: 'trackside' },
}

const reviewRoute: RoutingRule = {
  id: 'rt_review',
  name: 'Reviewer agent',
  priority: 100,
  enabled: true,
  trigger: {
    type: TRIGGER_TYPE.PR_REVIEW_REQUESTED,
    provider: TICKET_PROVIDER.GITHUB,
    projectId: 'trackside',
  },
  guard: { refire: 'per-change', markers: true },
  match: { reviewersAdded: { any: ['EomiAIBot'] } },
  target: { agentRef: { githubLogin: 'EomiAIBot' } },
  execution: { prompt: 'Review {{pr.number}}', requireApproval: false, timeoutSeconds: 60 },
  outcome: {},
}

function api(pulls: Array<Record<string, unknown>>): GitHubRestClient {
  return {
    issues: async () => [],
    pullRequests: async () => pulls,
  } as unknown as GitHubRestClient
}

function pull(overrides: Record<string, unknown> = {}) {
  return {
    number: 7,
    title: 'Fix the export',
    body: '',
    html_url: 'https://github.com/acme/trackside/pull/7',
    state: 'open',
    draft: false,
    updated_at: '2026-09-01T10:00:00Z',
    labels: [],
    assignees: [],
    requested_reviewers: [],
    requested_teams: [],
    base: { ref: 'main' },
    ...overrides,
  }
}

/** One poll cycle, driving the very code `main()` drives. */
async function cycle(
  db: Sentinel0Database,
  pulls: Array<Record<string, unknown>>
): Promise<TriggerEvent[]> {
  const events = await new GitHubService(api(pulls)).collect(project)
  return observeCycle(db, project.id, events)
}

const reviewEvent = (events: TriggerEvent[]) =>
  events.find((event) => event.type === TRIGGER_TYPE.PR_REVIEW_REQUESTED)

describe('a review request, end to end', () => {
  const requested = [pull({ requested_reviewers: [{ login: 'EomiAIBot' }] })]

  it('fires the review route on the cycle the reviewer is added', async () => {
    const db = openDatabase('memory')

    await cycle(db, [pull()])
    const event = reviewEvent(await cycle(db, requested))

    expect(explainRule(reviewRoute, event!)).toBeUndefined()
  })

  it('shares the pull request’s history with both events it raises', async () => {
    const db = openDatabase('memory')

    await cycle(db, [pull()])
    const events = await cycle(db, requested)

    // The narrower event exists only from this cycle; its history has to come
    // from the pr_event baseline seeded a cycle earlier.
    for (const event of events) {
      expect(event.changes?.reviewersAdded).toEqual(['EomiAIBot'])
    }
  })

  it('does not fire again while the request merely stays outstanding', async () => {
    const db = openDatabase('memory')

    await cycle(db, [pull()])
    await cycle(db, requested)
    const event = reviewEvent(await cycle(db, requested))

    expect(matchesRule(reviewRoute, event!)).toBe(false)
  })

  it('fires again when the review is re-requested after being answered', async () => {
    const db = openDatabase('memory')

    await cycle(db, [pull()])
    await cycle(db, requested)
    // Answering a review clears the request on GitHub's side.
    await cycle(db, [pull()])
    const event = reviewEvent(await cycle(db, requested))

    expect(matchesRule(reviewRoute, event!)).toBe(true)
  })

  it('stays quiet for a pull request whose reviewer was requested before it was ever seen', async () => {
    const db = openDatabase('memory')

    // First sight of the item, reviewer already attached: no history, so no
    // transition. This is the backlog guard, and it is one cycle of latency
    // rather than a route that can never fire.
    const event = reviewEvent(await cycle(db, requested))

    expect(matchesRule(reviewRoute, event!)).toBe(false)
    expect(explainRule(reviewRoute, event!)).toContain('never been observed before')
  })
})

describe('observations are keyed by item, not by trigger type', () => {
  it('migrates a database written under the old per-type keys', async () => {
    const db = openDatabase('memory')

    // What the previous release wrote: the pr_event row holds real history,
    // the pr_review_requested row is the one that was useless.
    const seed = (ref: string, reviewers: string[]) =>
      db.observe('trackside', ref, { labels: [], assignees: [], reviewers })

    seed('pr_event:acme/trackside#7', [])
    seed('pr_review_requested:acme/trackside#7', ['EomiAIBot'])

    db.migrateObservationKeys()

    // Promoted onto the bare ref, and pr_event's empty reviewer set won -- so
    // the pending request still reads as newly added rather than as history.
    const changes = db.changesSince('trackside', 'acme/trackside#7', {
      labels: [],
      assignees: [],
      reviewers: ['EomiAIBot'],
    })
    expect(changes?.reviewersAdded).toEqual(['EomiAIBot'])

    // And the legacy rows are gone rather than lingering until the pruner.
    expect(
      db.changesSince('trackside', 'pr_event:acme/trackside#7', {
        labels: [],
        assignees: [],
        reviewers: [],
      })
    ).toBeUndefined()
  })
})

describe('a pull request opened with its reviewer already attached', () => {
  /**
   * The case that survived the first fix. A bot opens a pull request and
   * requests a review seconds later, so the runner never sees that pull request
   * without `EomiAIBot` on it -- first sight, nothing to diff against, and the
   * only cycle that could have caught the request is the one that suppresses
   * it.
   */
  const born = (createdAt: string, reviewers: string[] = ['EomiAIBot']) =>
    pull({
      created_at: createdAt,
      updated_at: createdAt,
      requested_reviewers: reviewers.map((login) => ({ login })),
    })

  it('fires when the pull request was created since the last poll', async () => {
    const db = openDatabase('memory')

    // A first cycle, so the project has a watermark at all.
    await cycle(db, [pull({ number: 1, created_at: '2026-09-07T12:00:00Z' })])

    const event = reviewEvent(await cycle(db, [born('2026-09-07T13:19:18Z')]))
    expect(explainRule(reviewRoute, event!)).toBeUndefined()
  })

  it('stays quiet for a pull request that predates the runner’s first look', async () => {
    const db = openDatabase('memory')

    // The backlog guard: first cycle ever, everything in it already existed.
    const event = reviewEvent(await cycle(db, [born('2026-09-07T13:19:18Z')]))
    expect(matchesRule(reviewRoute, event!)).toBe(false)
  })

  it('does not re-fire the newly created pull request on later cycles', async () => {
    const db = openDatabase('memory')
    await cycle(db, [pull({ number: 1, created_at: '2026-09-07T12:00:00Z' })])

    const created = born('2026-09-07T13:19:18Z')
    expect(matchesRule(reviewRoute, reviewEvent(await cycle(db, [created]))!)).toBe(true)
    // Now it has been observed, so the ordinary transition rules take over.
    expect(matchesRule(reviewRoute, reviewEvent(await cycle(db, [created]))!)).toBe(false)
  })

  it('lets two pull requests opened between the same polls both fire', async () => {
    const db = openDatabase('memory')
    await cycle(db, [pull({ number: 1, created_at: '2026-09-07T12:00:00Z' })])

    const events = await cycle(db, [
      { ...born('2026-09-07T13:19:18Z'), number: 7 },
      { ...born('2026-09-07T13:20:00Z'), number: 8 },
    ])
    const reviews = events.filter((event) => event.type === TRIGGER_TYPE.PR_REVIEW_REQUESTED)

    expect(reviews).toHaveLength(2)
    for (const event of reviews) {
      expect(matchesRule(reviewRoute, event)).toBe(true)
    }
  })

  it('does not replay the backlog when a project is watched for the first time', async () => {
    const db = openDatabase('memory')

    // Twenty open pull requests, every one with the agent already requested.
    const backlog = Array.from({ length: 20 }, (_, index) => ({
      ...born('2026-09-01T09:00:00Z'),
      number: index + 1,
    }))
    const events = await cycle(db, backlog)
    const matched = events.filter((event) => matchesRule(reviewRoute, event))

    expect(matched).toHaveLength(0)
  })

  it('does not treat an older pull request as new once the watermark has moved', async () => {
    const db = openDatabase('memory')
    await cycle(db, [pull({ number: 1, created_at: '2026-09-07T14:00:00Z' })])

    // Appears later than something newer -- a reopen, or a widened filter.
    const late = { ...born('2026-09-07T13:00:00Z'), number: 9 }
    expect(matchesRule(reviewRoute, reviewEvent(await cycle(db, [late]))!)).toBe(false)
  })
})
