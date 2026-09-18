import { describe, expect, it } from 'vitest'
import {
  EMPTY_DRAFT,
  applyDraft,
  draftProblems,
  draftToNewRoute,
  placeholderValues,
  preservedParts,
  toDraft,
} from '../src/lib/routeDraft.js'
import { controlFor, labelFor } from '../src/components/RouteForm.js'
import type { RouteTemplate, RoutingRule } from '../src/api/types.js'

const stored: RoutingRule = {
  id: 'rt_1',
  name: 'Assess on label',
  priority: 100,
  enabled: true,
  guard: { refire: 'once', markers: true },
  trigger: { type: 'ticket', projectId: 'acme/platform' },
  match: { labels: { any: ['needs-agent'] } },
  target: { agentRef: { profile: 'product' } },
  execution: { prompt: 'Assess {{ticket.ref}}.', timeoutSeconds: 1800 },
  outcome: { postComment: { target: 'ticket' } },
}

describe('toDraft', () => {
  it('reads the form fields out of a stored rule', () => {
    expect(toDraft(stored)).toMatchObject({
      name: 'Assess on label',
      projectId: 'acme/platform',
      agentProfile: 'product',
      priority: '100',
      enabled: true,
      timeoutSeconds: '1800',
      prompt: 'Assess {{ticket.ref}}.',
    })
  })

  it('does not throw on a rule missing optional parts', () => {
    const sparse = { id: 'rt_2', name: 'x' } as RoutingRule
    expect(() => toDraft(sparse)).not.toThrow()
    expect(toDraft(sparse).priority).toBe('100')
  })
})

describe('applyDraft', () => {
  it('preserves and edits a workspace-scoped Linear identity without replacing it with a profile', () => {
    const base = {
      ...stored,
      target: { agentRef: { linearUserId: 'u1', linearWorkspaceId: 'w1' } },
    }
    const draft = toDraft(base)
    const saved = applyDraft(base, {
      ...draft,
      extras: { '<LINEAR_USER_ID>': 'u2', '<LINEAR_WORKSPACE_ID>': 'w2' },
    })
    expect(saved.target.agentRef).toEqual({ linearUserId: 'u2', linearWorkspaceId: 'w2' })
    expect(draft.extras).toEqual({ '<LINEAR_USER_ID>': 'u1', '<LINEAR_WORKSPACE_ID>': 'w1' })
  })
  /**
   * The reason this function exists. The form edits seven fields; a route also
   * carries the match clauses and the guard that stops it re-firing on the
   * agent's own work. Renaming a route must not drop those.
   */
  it('preserves everything the form does not edit', () => {
    const result = applyDraft(stored, { ...toDraft(stored), name: 'Renamed' })
    expect(result.name).toBe('Renamed')
    expect(result.guard).toEqual({ refire: 'once', markers: true })
    expect(result.match).toEqual({ labels: { any: ['needs-agent'] } })
    expect(result.outcome).toEqual({ postComment: { target: 'ticket' } })
    expect(result.trigger.type).toBe('ticket')
  })

  it('writes the edited fields through', () => {
    const result = applyDraft(stored, {
      ...toDraft(stored),
      projectId: 'acme/api',
      agentProfile: 'reviewer',
      priority: '10',
      enabled: false,
      timeoutSeconds: '600',
      prompt: 'Reassess.',
    })
    expect(result.trigger.projectId).toBe('acme/api')
    expect(result.target.agentRef).toEqual({ profile: 'reviewer' })
    expect(result.priority).toBe(10)
    expect(result.enabled).toBe(false)
    expect(result.execution.timeoutSeconds).toBe(600)
    expect(result.execution.prompt).toBe('Reassess.')
  })

  /**
   * A rule addresses an agent by profile or by GitHub login, never both — the
   * API rejects a githubLogin target on a ticket trigger, so writing both keys
   * would turn a valid route invalid on save.
   */
  it('keeps a githubLogin target addressed by login', () => {
    const byLogin: RoutingRule = {
      ...stored,
      trigger: { type: 'pr_review_requested', projectId: 'acme/platform' },
      target: { agentRef: { githubLogin: 'acme-reviewer' } },
    }
    const result = applyDraft(byLogin, {
      ...toDraft(byLogin),
      agentGithubLogin: 'acme-other',
      agentProfile: 'ignored',
    })
    expect(result.target.agentRef).toEqual({ githubLogin: 'acme-other' })
    expect(result.target.agentRef).not.toHaveProperty('profile')
  })

  it('falls back rather than writing NaN for an unparseable number', () => {
    const result = applyDraft(stored, { ...toDraft(stored), priority: '', timeoutSeconds: 'abc' })
    expect(result.priority).toBe(100)
    expect(result.execution.timeoutSeconds).toBe(1800)
  })

  it('trims the name, so a stray space is not part of it', () => {
    expect(applyDraft(stored, { ...toDraft(stored), name: '  Spaced  ' }).name).toBe('Spaced')
  })
})

describe('preservedParts', () => {
  it('shows what the form does not edit, and not what it does', () => {
    const parts = preservedParts(stored) as Record<string, unknown>
    expect(parts).toHaveProperty('guard')
    expect(parts).toHaveProperty('match')
    expect(parts).toHaveProperty('outcome')
    // The trigger is shown because it is half of "when does this fire".
    expect(parts).toHaveProperty('trigger')
    expect(parts).not.toHaveProperty('execution')
    expect(parts).not.toHaveProperty('name')
    expect(parts).not.toHaveProperty('id')
  })
})

describe('draftToNewRoute', () => {
  const template: RouteTemplate = {
    id: 't',
    name: 'Assess',
    summary: 's',
    description: 'd',
    placeholders: [
      { token: '<PROJECT_ID>', label: 'Project', hint: '' },
      { token: '<AGENT_PROFILE>', label: 'Agent', hint: '' },
      { token: '<LABEL>', label: 'Label', hint: '' },
    ],
    route: {
      name: 'Assess',
      priority: 100,
      enabled: true,
      guard: { refire: 'once', markers: true },
      trigger: { type: 'ticket', projectId: '<PROJECT_ID>' },
      match: { labels: { any: ['<LABEL>'] } },
      target: { agentRef: { profile: '<AGENT_PROFILE>' } },
      execution: { prompt: 'Assess in <PROJECT_ID>.', timeoutSeconds: 1800 },
    },
  }

  it('fills the template from the draft and then applies the edits', () => {
    const draft = {
      ...EMPTY_DRAFT,
      name: 'My route',
      projectId: 'acme/api',
      agentProfile: 'product',
      extras: { '<LABEL>': 'triage' },
      prompt: 'Custom prompt.',
    }
    const route = draftToNewRoute(template, draft)
    expect(route.name).toBe('My route')
    expect(route.trigger.projectId).toBe('acme/api')
    expect(route.target.agentRef).toEqual({ profile: 'product' })
    expect(route.match).toEqual({ labels: { any: ['triage'] } })
    // The edited prompt wins over the template's.
    expect(route.execution.prompt).toBe('Custom prompt.')
    expect(route.guard).toEqual({ refire: 'once', markers: true })
  })

  it('maps the draft onto the tokens the catalog uses', () => {
    expect(placeholderValues({ ...EMPTY_DRAFT, projectId: 'p', agentProfile: 'a' })).toMatchObject({
      '<PROJECT_ID>': 'p',
      '<AGENT_PROFILE>': 'a',
    })
  })
})

describe('draftProblems', () => {
  const complete = {
    ...EMPTY_DRAFT,
    name: 'n',
    projectId: 'p',
    agentProfile: 'a',
    prompt: 'go',
  }

  it('accepts a complete draft', () => {
    expect(draftProblems(complete, ['<PROJECT_ID>', '<AGENT_PROFILE>'])).toEqual([])
  })

  it('names each missing field rather than returning a bare false', () => {
    const problems = draftProblems(EMPTY_DRAFT, ['<PROJECT_ID>', '<AGENT_PROFILE>'])
    expect(problems.length).toBeGreaterThan(2)
    expect(problems.join(' ')).toMatch(/name/i)
    expect(problems.join(' ')).toMatch(/project/i)
    expect(problems.join(' ')).toMatch(/prompt/i)
  })

  it('requires a free-text placeholder the template declares', () => {
    expect(draftProblems(complete, ['<LABEL>'])).toEqual(['Fill in <LABEL>.'])
    expect(draftProblems({ ...complete, extras: { '<LABEL>': 'x' } }, ['<LABEL>'])).toEqual([])
  })

  // A pr_review_requested route matches on the identity asked to review, so a
  // profile is not what it needs.
  it('asks for a login, not a profile, when the route matches on one', () => {
    const problems = draftProblems({ ...EMPTY_DRAFT, name: 'n', projectId: 'p', prompt: 'go' }, [
      '<AGENT_GITHUB_LOGIN>',
    ])
    expect(problems.join(' ')).toMatch(/GitHub identity/)
  })
})

describe('controlFor', () => {
  it('gives the tokens the API knows about a dropdown', () => {
    expect(controlFor('<PROJECT_ID>')).toBe('project')
    expect(controlFor('<AGENT_PROFILE>')).toBe('agent')
    expect(controlFor('<AGENT_GITHUB_LOGIN>')).toBe('agent-login')
  })

  it('leaves anything else as free text', () => {
    expect(controlFor('<LABEL>')).toBe('text')
    expect(controlFor('<SOMETHING_NEW>')).toBe('text')
  })
})

describe('labelFor', () => {
  it('turns a token into a readable label', () => {
    expect(labelFor('<LABEL>')).toBe('Label')
    expect(labelFor('<BASE_BRANCH>')).toBe('Base branch')
  })
})
