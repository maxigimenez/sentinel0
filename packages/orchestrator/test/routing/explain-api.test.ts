import { describe, expect, it } from 'vitest'
import {
  TICKET_PROVIDER,
  TRIGGER_TYPE,
  type AgentDescriptor,
  type AppConfig,
  type ProjectConfig,
  type RoutingRule,
  type TriggerEvent,
} from '@sentinel0/common'
import { createApiServer, type ApiServerDeps } from '../../src/runtime/api-server.js'
import { openDatabase, type Sentinel0Database } from '../../src/database.js'

const project: ProjectConfig = {
  id: 'trackside',
  provider: TICKET_PROVIDER.GITHUB,
  filters: { owner: 'acme', repo: 'trackside' },
}

const route: RoutingRule = {
  id: 'rt_review',
  name: 'Reviewer agent',
  priority: 100,
  enabled: true,
  trigger: { type: TRIGGER_TYPE.PR_REVIEW_REQUESTED, projectId: 'trackside' },
  guard: { refire: 'per-change', markers: true },
  match: { reviewersAdded: { any: ['EomiAIBot'] } },
  target: { agentRef: { githubLogin: 'EomiAIBot' } },
  execution: { prompt: 'Review it', requireApproval: false, timeoutSeconds: 60 },
  outcome: {},
}

function reviewRequested(reviewers: string[]): TriggerEvent {
  return {
    type: TRIGGER_TYPE.PR_REVIEW_REQUESTED,
    projectId: 'trackside',
    provider: TICKET_PROVIDER.GITHUB,
    ref: 'acme/trackside#7',
    revision: 'r1',
    title: 'Fix the export',
    body: '',
    labels: [],
    assignees: [],
    prNumber: 7,
    requestedReviewers: reviewers,
    isDraft: false,
    baseBranch: 'main',
  }
}

/** Only what the explain route touches; the rest throws if it is reached. */
function server(db: Sentinel0Database, events: TriggerEvent[]) {
  return createApiServer({
    getConfig: () => ({ server: { apiPort: 0, networkAccess: false } }) as AppConfig,
    getProjects: () => [project],
    getAgents: () => [],
    getRoutes: () => [route],
    db,
    dataDir: '/tmp',
    collectTriggers: async () => events,
  } as unknown as ApiServerDeps)
}

const seen = (db: Sentinel0Database, reviewers: string[]) =>
  db.observe('trackside', 'acme/trackside#7', { labels: [], assignees: [], reviewers })

describe('GET /routes/explain', () => {
  it('reports the route that matches', async () => {
    const db = openDatabase('memory')
    seen(db, [])

    const app = await server(db, [reviewRequested(['EomiAIBot'])])
    const response = await app.inject({ method: 'GET', url: '/routes/explain' })

    expect(response.json().items[0].verdicts[0]).toMatchObject({
      routeId: 'rt_review',
      matched: true,
    })
    await app.close()
  })

  it('answers the same way twice, because asking must not consume the transition', async () => {
    const db = openDatabase('memory')
    seen(db, [])

    const app = await server(db, [reviewRequested(['EomiAIBot'])])
    const first = await app.inject({ method: 'GET', url: '/routes/explain' })
    const second = await app.inject({ method: 'GET', url: '/routes/explain' })

    expect(first.json().items[0].verdicts[0].matched).toBe(true)
    expect(second.json().items[0].verdicts[0].matched).toBe(true)
    await app.close()
  })

  it('names the clause that rejected', async () => {
    const db = openDatabase('memory')
    // The reviewer was already outstanding last cycle, so nothing was added.
    seen(db, ['EomiAIBot'])

    const app = await server(db, [reviewRequested(['EomiAIBot'])])
    const response = await app.inject({ method: 'GET', url: '/routes/explain' })

    const verdict = response.json().items[0].verdicts[0]
    expect(verdict.matched).toBe(false)
    expect(verdict.reason).toContain('match.reviewersAdded')
    await app.close()
  })

  it('reports a newly created pull request as matching, without recording it', async () => {
    const db = openDatabase('memory')
    // The project has been watched since noon; this pull request is newer, so
    // its reviewer really was added since the last look.
    db.advanceWatermark('trackside', '2026-09-07T12:00:00Z')

    const born = { ...reviewRequested(['EomiAIBot']), createdAt: '2026-09-07T13:19:18Z' }
    const app = await server(db, [born])

    const first = await app.inject({ method: 'GET', url: '/routes/explain' })
    const second = await app.inject({ method: 'GET', url: '/routes/explain' })

    expect(first.json().items[0].verdicts[0].matched).toBe(true)
    expect(second.json().items[0].verdicts[0].matched).toBe(true)
    // Explaining must not move the watermark either.
    expect(db.watermarkFor('trackside')).toBe('2026-09-07T12:00:00Z')
    await app.close()
  })

  it('flags a target that cannot resolve, even while the match fails for another reason', async () => {
    // Exactly the shape that cost a day: the eomi profile is up and working,
    // but no profile declares itself as EomiAIBot, so the route can never run.
    // The match fails first, on an unrelated clause, and used to be all that
    // was reported.
    const db = openDatabase('memory')
    seen(db, ['EomiAIBot'])

    const app = await createApiServer({
      getConfig: () => ({ server: { apiPort: 0, networkAccess: false } }) as AppConfig,
      getProjects: () => [project],
      getAgents: (): AgentDescriptor[] => [
        { profile: 'eomi', toolsets: [], skills: [], enabled: true, discoveredAt: 0 },
      ],
      getRoutes: () => [route],
      db,
      dataDir: '/tmp',
      collectTriggers: async () => [reviewRequested(['EomiAIBot'])],
    } as unknown as ApiServerDeps)

    const verdict = (await app.inject({ method: 'GET', url: '/routes/explain' })).json().items[0]
      .verdicts[0]

    expect(verdict.matched).toBe(false)
    expect(verdict.reason).toContain('match.reviewersAdded')
    expect(verdict.targetProblem).toContain('no enabled agent has githubLogin "EomiAIBot"')
    await app.close()
  })

  it('reports no target problem once a profile claims the identity', async () => {
    const db = openDatabase('memory')
    seen(db, [])

    const app = await createApiServer({
      getConfig: () => ({ server: { apiPort: 0, networkAccess: false } }) as AppConfig,
      getProjects: () => [project],
      getAgents: (): AgentDescriptor[] => [
        {
          profile: 'eomi',
          githubLogin: 'EomiAIBot',
          toolsets: [],
          skills: [],
          enabled: true,
          discoveredAt: 0,
        },
      ],
      getRoutes: () => [route],
      db,
      dataDir: '/tmp',
      collectTriggers: async () => [reviewRequested(['EomiAIBot'])],
    } as unknown as ApiServerDeps)

    const verdict = (await app.inject({ method: 'GET', url: '/routes/explain' })).json().items[0]
      .verdicts[0]

    expect(verdict.matched).toBe(true)
    expect(verdict.targetProblem).toBeUndefined()
    await app.close()
  })

  it('rejects a project this runner does not poll', async () => {
    const app = await server(openDatabase('memory'), [])
    const response = await app.inject({ method: 'GET', url: '/routes/explain?project=nope' })

    expect(response.statusCode).toBe(404)
    await app.close()
  })
})
