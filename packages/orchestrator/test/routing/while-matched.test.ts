import { beforeEach, describe, expect, it } from 'vitest'
import {
  RUN_STATUS,
  TICKET_PROVIDER,
  TRIGGER_TYPE,
  type RoutingRule,
  type RunRecord,
  type TriggerEvent,
} from '@sentinel0/common'
import { openDatabase, type Sentinel0Database } from '../../src/database.js'
import { dedupeKey, matchesRule } from '../../src/routing/rule-engine.js'

/**
 * The claim lifecycle for `while-matched`.
 *
 * Matching alone says nothing useful for these routes -- the state clause is
 * true for as long as the condition holds -- so what stops a second run is the
 * ledger claim, and what allows the *next* one is releasing it. Both halves
 * are tested here because either alone is wrong: never releasing means a route
 * fires once in its life, and releasing too eagerly means a run per poll.
 */

const route: RoutingRule = {
  id: 'rt_review',
  name: 'Reviewer agent',
  priority: 100,
  enabled: true,
  trigger: { type: TRIGGER_TYPE.PR_REVIEW_REQUESTED, projectId: 'trackside' },
  guard: { refire: 'while-matched', markers: true },
  match: { reviewers: { any: ['EomiAIBot'] } },
  target: { agentRef: { githubLogin: 'EomiAIBot' } },
  execution: { prompt: 'Review it', requireApproval: false, timeoutSeconds: 60 },
  outcome: {},
}

function asked(overrides: Partial<TriggerEvent> = {}): TriggerEvent {
  return {
    type: TRIGGER_TYPE.PR_REVIEW_REQUESTED,
    projectId: 'trackside',
    provider: TICKET_PROVIDER.GITHUB,
    ref: 'acme/trackside#408',
    revision: 'r1',
    title: 'Patch advisories',
    body: '',
    labels: [],
    assignees: [],
    prNumber: 408,
    requestedReviewers: ['EomiAIBot'],
    isDraft: false,
    baseBranch: 'main',
    ...overrides,
  }
}

describe('while-matched', () => {
  let db: Sentinel0Database

  beforeEach(() => {
    db = openDatabase('memory')
  })

  const claim = (event: TriggerEvent, runId = 'run_1') =>
    db.claimDispatch(
      dedupeKey(route, event),
      { runId, routeId: route.id, triggerRef: event.ref },
      Date.now()
    )

  const settled = (runId: string, status = RUN_STATUS.COMPLETED): RunRecord =>
    ({
      id: runId,
      routeId: route.id,
      routeName: route.name,
      agentProfile: 'eomi',
      projectId: 'trackside',
      triggerType: TRIGGER_TYPE.PR_REVIEW_REQUESTED,
      triggerRef: 'acme/trackside#408',
      triggerRevision: 'r1',
      title: 'Review',
      status,
      createdAt: 1,
      updatedAt: 1,
    }) as RunRecord

  it('fires on a review that was already outstanding, with no transition to observe', () => {
    // The whole point: no `changes` at all, and it still matches.
    expect(matchesRule(route, asked())).toBe(true)
  })

  it('does not start a second run while the request is still outstanding', () => {
    expect(claim(asked())).toBe(true)
    // A push moves the revision; the key must not, so the claim still holds.
    expect(claim(asked({ revision: 'pushed' }), 'run_2')).toBe(false)
  })

  it('re-arms once the request is answered, and fires again when asked again', () => {
    claim(asked())
    db.createRun(settled('run_1'))

    // The reviewer submitted, so GitHub cleared the request and the trigger is
    // no longer raised for this pull request at all.
    expect(db.releaseUnmatchedClaims(route.id, [])).toBe(1)

    // Asked again -- same key as the first round, and it must be free.
    expect(claim(asked({ revision: 'r2' }), 'run_2')).toBe(true)
  })

  it('keeps the claim while the item still matches', () => {
    claim(asked())
    db.createRun(settled('run_1'))

    expect(db.releaseUnmatchedClaims(route.id, ['acme/trackside#408'])).toBe(0)
    expect(claim(asked(), 'run_2')).toBe(false)
  })

  it('never releases a claim whose run is still going', () => {
    claim(asked())
    db.createRun(settled('run_1', RUN_STATUS.RUNNING))

    // Mid-run the item carries sentinel0:in-progress and so stops matching by
    // construction. Releasing on that basis would re-arm the route against the
    // work it is still doing.
    expect(db.releaseUnmatchedClaims(route.id, [])).toBe(0)
  })

  it('leaves a run awaiting a human decision alone', () => {
    claim(asked())
    db.createRun(settled('run_1', RUN_STATUS.AWAITING_APPROVAL))

    expect(db.releaseUnmatchedClaims(route.id, [])).toBe(0)
  })

  it('re-arms after a failed run, so a fix can be retried', () => {
    claim(asked())
    db.createRun(settled('run_1', RUN_STATUS.FAILED))

    expect(db.releaseUnmatchedClaims(route.id, [])).toBe(1)
  })

  it('touches no other route’s claims', () => {
    claim(asked())
    db.claimDispatch(
      'other-key',
      { runId: 'run_9', routeId: 'rt_other', triggerRef: 'acme/trackside#408' },
      Date.now()
    )

    db.releaseUnmatchedClaims(route.id, [])
    expect(db.hasDispatched('other-key')).toBe(true)
  })
})
