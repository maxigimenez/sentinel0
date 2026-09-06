import { beforeEach, describe, expect, it } from 'vitest'
import {
  SENTINEL0_LABEL,
  TICKET_PROVIDER,
  TRIGGER_TYPE,
  type RoutingRule,
  type TriggerEvent,
} from '@sentinel0/common'
import { dedupeKey, evaluate, matchesRule } from '../../src/routing/rule-engine.js'
import { openDatabase, type Sentinel0Database } from '../../src/database.js'

function rule(overrides: Partial<RoutingRule> = {}): RoutingRule {
  return {
    id: 'rt_1',
    name: 'PR route',
    priority: 0,
    enabled: true,
    trigger: { type: TRIGGER_TYPE.PR_EVENT, provider: TICKET_PROVIDER.GITHUB, projectId: 'www' },
    match: {},
    target: { agentRef: { profile: 'reviewer' } },
    execution: { prompt: 'Review {{pr.number}}', requireApproval: false, timeoutSeconds: 60 },
    outcome: {},
    ...overrides,
  }
}

function pr(overrides: Partial<TriggerEvent> = {}): TriggerEvent {
  return {
    type: TRIGGER_TYPE.PR_EVENT,
    projectId: 'www',
    provider: TICKET_PROVIDER.GITHUB,
    ref: 'acme/www#42',
    revision: 'rev-1',
    title: 'Add billing export',
    body: 'Adds CSV.',
    labels: [],
    assignees: [],
    prNumber: 42,
    requestedReviewers: [],
    isDraft: false,
    baseBranch: 'main',
    ...overrides,
  }
}

describe('assignee matching', () => {
  it('fires when the PR is assigned to the named person', () => {
    const assigned = rule({ match: { assignees: { any: ['acme-bot'] } } })

    expect(matchesRule(assigned, pr({ assignees: ['acme-bot'] }))).toBe(true)
    expect(matchesRule(assigned, pr({ assignees: ['someone-else'] }))).toBe(false)
    expect(matchesRule(assigned, pr({ assignees: [] }))).toBe(false)
  })

  it('is case-insensitive, as GitHub logins are', () => {
    const assigned = rule({ match: { assignees: { any: ['Acme-Bot'] } } })
    expect(matchesRule(assigned, pr({ assignees: ['acme-bot'] }))).toBe(true)
  })
})

describe('draft and base branch', () => {
  it('can exclude drafts', () => {
    const ready = rule({ match: { isDraft: false } })
    expect(matchesRule(ready, pr({ isDraft: false }))).toBe(true)
    expect(matchesRule(ready, pr({ isDraft: true }))).toBe(false)
  })

  it('can target one base branch', () => {
    const toMain = rule({ match: { baseBranch: { any: ['main'] } } })
    expect(matchesRule(toMain, pr({ baseBranch: 'main' }))).toBe(true)
    expect(matchesRule(toMain, pr({ baseBranch: 'release' }))).toBe(false)
  })
})

describe('transition matching', () => {
  const onLabelAdded = rule({ match: { labelsAdded: { any: ['needs-review'] } } })

  it('fires when the label was just added', () => {
    const event = pr({
      labels: ['needs-review'],
      changes: {
        labelsAdded: ['needs-review'],
        labelsRemoved: [],
        assigneesAdded: [],
        assigneesRemoved: [],
        reviewersAdded: [],
      },
    })
    expect(matchesRule(onLabelAdded, event)).toBe(true)
  })

  it('does not fire when the label is merely present', () => {
    const event = pr({
      labels: ['needs-review'],
      changes: {
        labelsAdded: [],
        labelsRemoved: [],
        assigneesAdded: [],
        assigneesRemoved: [],
        reviewersAdded: [],
      },
    })
    expect(matchesRule(onLabelAdded, event)).toBe(false)
  })

  it('stays quiet on first sight, so a new route does not fire across a backlog', () => {
    // No `changes` at all: this item has never been observed before.
    expect(matchesRule(onLabelAdded, pr({ labels: ['needs-review'] }))).toBe(false)
  })

  it('can fire on a label being removed', () => {
    const onRemoved = rule({ match: { labelsRemoved: { any: ['blocked'] } } })
    const event = pr({
      labels: [],
      changes: {
        labelsAdded: [],
        labelsRemoved: ['blocked'],
        assigneesAdded: [],
        assigneesRemoved: [],
        reviewersAdded: [],
      },
    })
    expect(matchesRule(onRemoved, event)).toBe(true)
  })

  it('can fire on an assignee being added', () => {
    const onAssigned = rule({ match: { assigneesAdded: { any: ['acme-bot'] } } })
    const event = pr({
      assignees: ['acme-bot'],
      changes: {
        labelsAdded: [],
        labelsRemoved: [],
        assigneesAdded: ['acme-bot'],
        assigneesRemoved: [],
        reviewersAdded: [],
      },
    })
    expect(matchesRule(onAssigned, event)).toBe(true)
  })
})

describe('loop guard', () => {
  it('never matches an item a run is already working on', () => {
    const anyRoute = rule({ guard: { refire: 'per-change', markers: true } })
    expect(matchesRule(anyRoute, pr({ labels: [SENTINEL0_LABEL.IN_PROGRESS] }))).toBe(false)
  })

  it('holds even for a route that opted out of markers', () => {
    // An in-flight run is never a good time to start a second one.
    const noMarkers = rule({ guard: { refire: 'per-change', markers: false } })
    expect(matchesRule(noMarkers, pr({ labels: [SENTINEL0_LABEL.IN_PROGRESS] }))).toBe(false)
  })

  it('declines an item a once-route already finished', () => {
    const once = rule({ guard: { refire: 'once', markers: true } })
    expect(matchesRule(once, pr({ labels: [SENTINEL0_LABEL.DONE] }))).toBe(false)
    expect(matchesRule(once, pr({ labels: [SENTINEL0_LABEL.FAILED] }))).toBe(false)
  })

  it('lets a per-change route run again after a completed one', () => {
    const repeat = rule({ guard: { refire: 'per-change', markers: true } })
    expect(matchesRule(repeat, pr({ labels: [SENTINEL0_LABEL.DONE] }))).toBe(true)
  })

  it('defaults to once, so a route written without thinking cannot loop', () => {
    expect(matchesRule(rule(), pr({ labels: [SENTINEL0_LABEL.DONE] }))).toBe(false)
  })

  it('ignores the revision under once, so changes cannot retrigger it', () => {
    const once = rule({ guard: { refire: 'once', markers: true } })
    expect(dedupeKey(once, pr({ revision: 'a' }))).toBe(dedupeKey(once, pr({ revision: 'b' })))
  })

  it('honours the revision under per-change', () => {
    const repeat = rule({ guard: { refire: 'per-change', markers: true } })
    expect(dedupeKey(repeat, pr({ revision: 'a' }))).not.toBe(
      dedupeKey(repeat, pr({ revision: 'b' }))
    )
  })

  it('still separates the two trigger types for the same pull request', () => {
    const once = rule({ guard: { refire: 'once', markers: true } })
    expect(dedupeKey(once, pr({ type: TRIGGER_TYPE.PR_EVENT }))).not.toBe(
      dedupeKey(once, pr({ type: TRIGGER_TYPE.PR_REVIEW_REQUESTED }))
    )
  })
})

describe('review-requested routing still works alongside pr_event', () => {
  it('picks the review route only for the requested agent', () => {
    const review = rule({
      id: 'rt_review',
      trigger: { type: TRIGGER_TYPE.PR_REVIEW_REQUESTED, projectId: 'www' },
      target: { agentRef: { githubLogin: 'acme-reviewer' } },
    })
    const event = pr({
      type: TRIGGER_TYPE.PR_REVIEW_REQUESTED,
      requestedReviewers: ['acme-reviewer'],
    })

    expect(evaluate([review], event)?.id).toBe('rt_review')
    expect(evaluate([review], { ...event, requestedReviewers: ['other'] })).toBeNull()
  })
})

describe('observation store', () => {
  let db: Sentinel0Database

  beforeEach(() => {
    db = openDatabase('memory')
  })

  const state = (labels: string[], assignees: string[] = []) => ({
    labels,
    assignees,
    reviewers: [],
  })

  it('reports nothing the first time an item is seen', () => {
    expect(db.observe('www', 'acme/www#42', state(['a']))).toBeUndefined()
  })

  it('reports what changed on the second sighting', () => {
    db.observe('www', 'acme/www#42', state(['a']))
    const changes = db.observe('www', 'acme/www#42', state(['b']))

    expect(changes).toMatchObject({ labelsAdded: ['b'], labelsRemoved: ['a'] })
  })

  it('reports nothing changed when nothing changed', () => {
    db.observe('www', 'acme/www#42', state(['a']))
    const changes = db.observe('www', 'acme/www#42', state(['a']))

    expect(changes).toMatchObject({ labelsAdded: [], labelsRemoved: [] })
  })

  it('tracks assignees alongside labels', () => {
    db.observe('www', 'acme/www#42', state([], ['alice']))
    const changes = db.observe('www', 'acme/www#42', state([], ['alice', 'bob']))

    expect(changes?.assigneesAdded).toEqual(['bob'])
    expect(changes?.assigneesRemoved).toEqual([])
  })

  it('keeps items in different projects apart', () => {
    db.observe('www', 'shared#1', state(['a']))
    expect(db.observe('api', 'shared#1', state(['a']))).toBeUndefined()
  })

  it('prunes only what is older than the cutoff', () => {
    db.observe('www', 'old', state([]), 100)
    db.observe('www', 'recent', state([]), 900)

    expect(db.pruneObservations(500)).toBe(1)
    expect(db.observe('www', 'recent', state([]))).toBeDefined()
    expect(db.observe('www', 'old', state([]))).toBeUndefined()
  })
})

describe('the review cycle: request, review, re-request, review again', () => {
  const reviewRoute = rule({
    id: 'rt_review',
    trigger: { type: TRIGGER_TYPE.PR_REVIEW_REQUESTED, projectId: 'www' },
    // Fires on the *act* of requesting review, not while a request is pending.
    match: { reviewersAdded: { any: ['acme-reviewer'] } },
    target: { agentRef: { githubLogin: 'acme-reviewer' } },
    guard: { refire: 'per-change', markers: true },
  })

  const review = (overrides: Partial<TriggerEvent> = {}) =>
    pr({
      type: TRIGGER_TYPE.PR_REVIEW_REQUESTED,
      requestedReviewers: ['acme-reviewer'],
      ...overrides,
    })

  const changes = (over: Partial<NonNullable<TriggerEvent['changes']>> = {}) => ({
    labelsAdded: [],
    labelsRemoved: [],
    assigneesAdded: [],
    assigneesRemoved: [],
    reviewersAdded: [],
    ...over,
  })

  it('fires when the agent is first requested', () => {
    const event = review({ changes: changes({ reviewersAdded: ['acme-reviewer'] }) })
    expect(matchesRule(reviewRoute, event)).toBe(true)
  })

  it('does not fire again merely because the request is still outstanding', () => {
    // Same PR, next poll: nothing was added, so nothing happens.
    expect(matchesRule(reviewRoute, review({ changes: changes() }))).toBe(false)
  })

  it('does not fire when the author pushes commits or replies', () => {
    // An author reply changes the PR but adds no reviewer, so the agent is not
    // re-summoned by conversation alone.
    const event = review({ revision: 'rev-2', changes: changes({ labelsAdded: ['discussion'] }) })
    expect(matchesRule(reviewRoute, event)).toBe(false)
  })

  it('fires again when the agent is re-requested for a second round', () => {
    const event = review({
      revision: 'rev-3',
      changes: changes({ reviewersAdded: ['acme-reviewer'] }),
    })
    expect(matchesRule(reviewRoute, event)).toBe(true)
  })

  it('gives each round its own dedupe key, so round two is not a duplicate', () => {
    const first = review({ revision: 'rev-1' })
    const second = review({ revision: 'rev-3' })
    expect(dedupeKey(reviewRoute, first)).not.toBe(dedupeKey(reviewRoute, second))
  })

  it('ignores a request for a different reviewer', () => {
    const event = review({
      requestedReviewers: ['someone-else'],
      changes: changes({ reviewersAdded: ['someone-else'] }),
    })
    expect(matchesRule(reviewRoute, event)).toBe(false)
  })

  it('still refuses to start while a round is in flight', () => {
    const event = review({
      labels: [SENTINEL0_LABEL.IN_PROGRESS],
      changes: changes({ reviewersAdded: ['acme-reviewer'] }),
    })
    expect(matchesRule(reviewRoute, event)).toBe(false)
  })

  it('is not blocked by sentinel0:done from the previous round', () => {
    const event = review({
      labels: [SENTINEL0_LABEL.DONE],
      revision: 'rev-3',
      changes: changes({ reviewersAdded: ['acme-reviewer'] }),
    })
    expect(matchesRule(reviewRoute, event)).toBe(true)
  })
})

/**
 * Targeting an agent by its GitHub account.
 *
 * The gate behind `target.agentRef.githubLogin` used to consult requested
 * reviewers and nothing else, while route validation happily accepted the same
 * target on a `pr_event` trigger. The obvious route -- assign the pull request
 * to the agent -- was therefore saveable and could never fire, with no error
 * anywhere to say so.
 */
describe('targeting an agent by github login', () => {
  const targeted = (match: RoutingRule['match']): RoutingRule =>
    rule({ match, target: { agentRef: { githubLogin: 'acme-bot' } } })

  it('fires when the agent is assigned, not only when review is requested', () => {
    const route = targeted({ assigneesAdded: { any: ['acme-bot'] } })
    const event = pr({
      assignees: ['acme-bot'],
      changes: {
        labelsAdded: [],
        labelsRemoved: [],
        assigneesAdded: ['acme-bot'],
        assigneesRemoved: [],
        reviewersAdded: [],
      },
    })

    expect(matchesRule(route, event)).toBe(true)
  })

  it('still fires when the agent is requested as a reviewer', () => {
    const route = targeted({ reviewersAdded: { any: ['acme-bot'] } })
    const event = pr({
      requestedReviewers: ['acme-bot'],
      changes: {
        labelsAdded: [],
        labelsRemoved: [],
        assigneesAdded: [],
        assigneesRemoved: [],
        reviewersAdded: ['acme-bot'],
      },
    })

    expect(matchesRule(route, event)).toBe(true)
  })

  it('does not fire when someone else was named', () => {
    const route = targeted({ assignees: { any: ['acme-bot'] } })

    expect(
      matchesRule(route, pr({ assignees: ['someone-else'], requestedReviewers: ['another-bot'] }))
    ).toBe(false)
  })

  it('matches the login however it is capitalized', () => {
    const route = targeted({})

    expect(matchesRule(route, pr({ assignees: ['ACME-Bot'] }))).toBe(true)
  })
})

describe('reviewers as current state', () => {
  it('matches an outstanding request without needing history', () => {
    // The transition clause cannot fire the first time an item is seen, because
    // there is nothing to compare against. This one can, for the routes that
    // would rather catch a standing request than miss it.
    const route = rule({ match: { reviewers: { any: ['acme-bot'] } } })

    expect(matchesRule(route, pr({ requestedReviewers: ['acme-bot'] }))).toBe(true)
    expect(matchesRule(route, pr({ requestedReviewers: [] }))).toBe(false)
  })
})
