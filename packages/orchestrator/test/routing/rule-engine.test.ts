import { describe, expect, it } from 'vitest'
import {
  TICKET_PROVIDER,
  TRIGGER_TYPE,
  type AgentDescriptor,
  type RoutingRule,
  type TriggerEvent,
} from '@sentinel0/common'
import {
  dedupeKey,
  evaluate,
  explainRule,
  explainTarget,
  matchesRule,
  matchesSet,
  resolveAgent,
} from '../../src/routing/rule-engine.js'

function rule(overrides: Partial<RoutingRule> = {}): RoutingRule {
  return {
    id: 'rt_default',
    name: 'Default',
    priority: 0,
    enabled: true,
    trigger: { type: TRIGGER_TYPE.TICKET, provider: TICKET_PROVIDER.LINEAR, projectId: 'taplands' },
    match: {},
    target: { agentRef: { profile: 'product' } },
    execution: { prompt: 'Review {{ticket.ref}}', requireApproval: false, timeoutSeconds: 1800 },
    outcome: {},
    ...overrides,
  }
}

function event(overrides: Partial<TriggerEvent> = {}): TriggerEvent {
  return {
    type: TRIGGER_TYPE.TICKET,
    projectId: 'taplands',
    provider: TICKET_PROVIDER.LINEAR,
    ref: 'LIN-123',
    revision: 'rev-1',
    title: 'Add billing export',
    body: 'We need a CSV export.',
    labels: ['feasibility'],
    state: 'Backlog',
    ...overrides,
  }
}

describe('matchesSet', () => {
  it('imposes no constraint when undefined or empty', () => {
    expect(matchesSet(undefined, [])).toBe(true)
    expect(matchesSet({}, ['a'])).toBe(true)
    expect(matchesSet({ any: [], all: [], none: [] }, [])).toBe(true)
  })

  it('treats any as OR and all as AND', () => {
    expect(matchesSet({ any: ['a', 'z'] }, ['a', 'b'])).toBe(true)
    expect(matchesSet({ any: ['z'] }, ['a', 'b'])).toBe(false)
    expect(matchesSet({ all: ['a', 'b'] }, ['a', 'b', 'c'])).toBe(true)
    expect(matchesSet({ all: ['a', 'z'] }, ['a', 'b'])).toBe(false)
  })

  it('treats none as NOR', () => {
    expect(matchesSet({ none: ['z'] }, ['a'])).toBe(true)
    expect(matchesSet({ none: ['a'] }, ['a'])).toBe(false)
  })

  it('compares case-insensitively and ignores surrounding whitespace', () => {
    expect(matchesSet({ any: ['Feasibility'] }, [' feasibility '])).toBe(true)
  })

  it('combines clauses conjunctively', () => {
    const match = { any: ['a', 'b'], none: ['blocked'] }
    expect(matchesSet(match, ['a'])).toBe(true)
    expect(matchesSet(match, ['a', 'blocked'])).toBe(false)
  })
})

describe('matchesRule', () => {
  it('matches a bare rule against a matching event', () => {
    expect(matchesRule(rule(), event())).toBe(true)
  })

  it('never matches a disabled rule', () => {
    expect(matchesRule(rule({ enabled: false }), event())).toBe(false)
  })

  it('requires trigger type, project, and provider to line up', () => {
    expect(matchesRule(rule(), event({ type: TRIGGER_TYPE.PR_EVENT }))).toBe(false)
    expect(matchesRule(rule(), event({ projectId: 'other' }))).toBe(false)
    expect(matchesRule(rule(), event({ provider: TICKET_PROVIDER.GITHUB }))).toBe(false)
  })

  it('ignores provider when the rule does not pin one', () => {
    const anyProvider = rule({
      trigger: { type: TRIGGER_TYPE.TICKET, projectId: 'taplands' },
    })
    expect(matchesRule(anyProvider, event({ provider: TICKET_PROVIDER.GITHUB }))).toBe(true)
  })

  it('filters on labels and state', () => {
    const labelled = rule({ match: { labels: { any: ['feasibility'] } } })
    expect(matchesRule(labelled, event())).toBe(true)
    expect(matchesRule(labelled, event({ labels: ['bug'] }))).toBe(false)

    const staged = rule({ match: { state: { any: ['Backlog'] } } })
    expect(matchesRule(staged, event())).toBe(true)
    expect(matchesRule(staged, event({ state: 'Done' }))).toBe(false)
    expect(matchesRule(staged, event({ state: undefined }))).toBe(false)
  })

  it('applies title and body patterns', () => {
    expect(matchesRule(rule({ match: { titleMatches: '^Add' } }), event())).toBe(true)
    expect(matchesRule(rule({ match: { titleMatches: '^RFC:' } }), event())).toBe(false)
    expect(matchesRule(rule({ match: { bodyMatches: 'CSV' } }), event())).toBe(true)
  })

  it('fails closed on an invalid pattern rather than matching everything', () => {
    expect(matchesRule(rule({ match: { titleMatches: '([unclosed' } }), event())).toBe(false)
  })

  it('only fires a githubLogin-targeted rule when that login was requested', () => {
    const reviewer = rule({
      trigger: { type: TRIGGER_TYPE.PR_REVIEW_REQUESTED, projectId: 'taplands' },
      target: { agentRef: { githubLogin: 'acme-reviewer-bot' } },
    })

    const prEvent = event({
      type: TRIGGER_TYPE.PR_REVIEW_REQUESTED,
      provider: TICKET_PROVIDER.GITHUB,
      requestedReviewers: ['Acme-Reviewer-Bot'],
    })

    expect(matchesRule(reviewer, prEvent)).toBe(true)
    expect(matchesRule(reviewer, { ...prEvent, requestedReviewers: ['someone-else'] })).toBe(false)
    expect(matchesRule(reviewer, { ...prEvent, requestedReviewers: undefined })).toBe(false)
  })
})

describe('evaluate', () => {
  it('returns null when nothing matches', () => {
    expect(evaluate([rule({ match: { labels: { any: ['nope'] } } })], event())).toBeNull()
    expect(evaluate([], event())).toBeNull()
  })

  it('picks the highest priority match', () => {
    const low = rule({ id: 'rt_low', priority: 1 })
    const high = rule({ id: 'rt_high', priority: 100 })
    expect(evaluate([low, high], event())?.id).toBe('rt_high')
    expect(evaluate([high, low], event())?.id).toBe('rt_high')
  })

  it('breaks priority ties deterministically by id', () => {
    const b = rule({ id: 'rt_b', priority: 5 })
    const a = rule({ id: 'rt_a', priority: 5 })
    expect(evaluate([b, a], event())?.id).toBe('rt_a')
    expect(evaluate([a, b], event())?.id).toBe('rt_a')
  })

  it('skips higher-priority rules that do not match', () => {
    const highButWrong = rule({ id: 'rt_high', priority: 100, match: { labels: { any: ['bug'] } } })
    const lowButRight = rule({ id: 'rt_low', priority: 1 })
    expect(evaluate([highButWrong, lowButRight], event())?.id).toBe('rt_low')
  })

  it('does not mutate the caller list', () => {
    const rules = [rule({ id: 'rt_a', priority: 1 }), rule({ id: 'rt_b', priority: 9 })]
    evaluate(rules, event())
    expect(rules.map((entry) => entry.id)).toEqual(['rt_a', 'rt_b'])
  })
})

describe('dedupeKey', () => {
  it('is stable for an unchanged ticket', () => {
    expect(dedupeKey(rule(), event())).toBe(dedupeKey(rule(), event()))
  })

  it('changes when the ticket revision changes, for a per-change route', () => {
    const repeat = rule({ guard: { refire: 'per-change', markers: true } })
    expect(dedupeKey(repeat, event())).not.toBe(dedupeKey(repeat, event({ revision: 'rev-2' })))
  })

  it('ignores the revision by default, because routes fire once by default', () => {
    expect(dedupeKey(rule(), event())).toBe(dedupeKey(rule(), event({ revision: 'rev-2' })))
  })

  it('separates different rules and different tickets', () => {
    expect(dedupeKey(rule({ id: 'rt_a' }), event())).not.toBe(
      dedupeKey(rule({ id: 'rt_b' }), event())
    )
    expect(dedupeKey(rule(), event())).not.toBe(dedupeKey(rule(), event({ ref: 'LIN-999' })))
  })
})

describe('explainRule', () => {
  it('says nothing when the rule matches', () => {
    expect(explainRule(rule(), event())).toBeUndefined()
  })

  it('agrees with matchesRule, which is defined in terms of it', () => {
    const cases: Array<[RoutingRule, TriggerEvent]> = [
      [rule(), event()],
      [rule({ enabled: false }), event()],
      [rule({ match: { labels: { any: ['nope'] } } }), event()],
      [rule({ trigger: { type: TRIGGER_TYPE.PR_EVENT, projectId: 'taplands' } }), event()],
      [rule({ match: { titleMatches: 'billing' } }), event()],
    ]
    for (const [candidate, incoming] of cases) {
      expect(matchesRule(candidate, incoming)).toBe(explainRule(candidate, incoming) === undefined)
    }
  })

  it('names the disabled route rather than a clause', () => {
    expect(explainRule(rule({ enabled: false }), event())).toBe('the route is disabled')
  })

  it('reports the clause that rejected, and what the event actually had', () => {
    const reason = explainRule(rule({ match: { labels: { any: ['urgent'] } } }), event())
    expect(reason).toContain('match.labels')
    expect(reason).toContain('urgent')
    expect(reason).toContain('feasibility')
  })

  it('distinguishes "no history yet" from "nothing changed"', () => {
    const onLabel = rule({ match: { labelsAdded: { any: ['urgent'] } } })

    expect(explainRule(onLabel, event())).toContain('never been observed before')
    expect(
      explainRule(
        onLabel,
        event({
          changes: {
            labelsAdded: [],
            labelsRemoved: [],
            assigneesAdded: [],
            assigneesRemoved: [],
            reviewersAdded: [],
          },
        })
      )
    ).toContain('nothing changed there')
  })

  it('explains an agent addressed by a login nobody named on the item', () => {
    const targeted = rule({
      trigger: { type: TRIGGER_TYPE.PR_EVENT, projectId: 'taplands' },
      target: { agentRef: { githubLogin: 'EomiAIBot' } },
    })
    const reason = explainRule(targeted, event({ type: TRIGGER_TYPE.PR_EVENT, assignees: [] }))

    expect(reason).toContain('EomiAIBot')
    expect(reason).toContain('neither assigned to nor a requested reviewer')
  })

  it('explains a marker label holding a once-route back', () => {
    const once = rule({ guard: { refire: 'once', markers: true } })
    expect(explainRule(once, event({ labels: ['sentinel0:done'] }))).toContain('re-arm')
  })
})

describe('explainTarget', () => {
  const agent = (overrides: Partial<AgentDescriptor> = {}): AgentDescriptor => ({
    profile: 'eomi',
    toolsets: [],
    skills: [],
    enabled: true,
    discoveredAt: 0,
    ...overrides,
  })

  it('says nothing when the target resolves by profile', () => {
    expect(explainTarget([agent()], { agentRef: { profile: 'eomi' } })).toBeUndefined()
  })

  it('says nothing when the target resolves by GitHub identity, case-insensitively', () => {
    const agents = [agent({ githubLogin: 'EomiAIBot' })]
    expect(explainTarget(agents, { agentRef: { githubLogin: 'eomiaibot' } })).toBeUndefined()
  })

  it('names a profile nothing answers to', () => {
    expect(explainTarget([agent()], { agentRef: { profile: 'ghost' } })).toContain(
      'no agent has the profile "ghost"'
    )
  })

  it('distinguishes a disabled agent from a missing one', () => {
    const agents = [agent({ enabled: false })]
    expect(explainTarget(agents, { agentRef: { profile: 'eomi' } })).toContain('is disabled')
  })

  it('points at the unset githubLogin, which is the actual cause', () => {
    // The profile exists and works; nobody told Sentinel0 which account it is.
    const agents = [agent({ profile: 'eomi' }), agent({ profile: 'james' })]
    const problem = explainTarget(agents, { agentRef: { githubLogin: 'EomiAIBot' } })

    expect(problem).toContain('no enabled agent has githubLogin "EomiAIBot"')
    expect(problem).toContain('eomi, james')
    expect(problem).toContain('config.json')
  })

  it('does not blame an unset login when some agent does claim the identity', () => {
    const agents = [agent({ githubLogin: 'EomiAIBot', enabled: false })]
    expect(explainTarget(agents, { agentRef: { githubLogin: 'EomiAIBot' } })).toContain(
      'is disabled'
    )
  })

  it('rejects a target that names nothing at all', () => {
    expect(explainTarget([agent()], { agentRef: {} })).toContain('neither a profile nor a')
  })
})

describe('resolveAgent is the dispatcher’s own resolution', () => {
  it('ignores disabled agents, so a match cannot start a switched-off profile', () => {
    const agents: AgentDescriptor[] = [
      { profile: 'eomi', toolsets: [], skills: [], enabled: false, discoveredAt: 0 },
    ]
    expect(resolveAgent(agents, { agentRef: { profile: 'eomi' } })).toBeUndefined()
  })
})
