import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  COMMENT_TARGET,
  RUN_STATUS,
  SENTINEL0_LABEL,
  TICKET_PROVIDER,
  TRIGGER_TYPE,
  type AgentDescriptor,
  type Logger,
  type RoutingRule,
  type TriggerEvent,
} from '@sentinel0/common'
import { openDatabase, type Sentinel0Database } from '../../src/database.js'
import { HermesClient } from '../../src/hermes/client.js'
import { HermesAdapter } from '../../src/hermes/adapter.js'
import { Dispatcher, type OutcomeHandlers } from '../../src/routing/dispatcher.js'
import { RunLifecycle } from '../../src/routing/run-lifecycle.js'
import { startFakeHermes, type FakeHermes } from '../hermes/fake-hermes-server.js'

let db: Sentinel0Database
let server: FakeHermes | undefined
let warnings: string[]

const logger: Logger = {
  info: () => undefined,
  success: () => undefined,
  warn: (msg) => warnings.push(msg),
  error: (msg) => warnings.push(msg),
  event: () => undefined,
}

beforeEach(() => {
  db = openDatabase('memory')
  warnings = []
})

afterEach(async () => {
  await server?.close()
  server = undefined
})

function agent(overrides: Partial<AgentDescriptor> = {}): AgentDescriptor {
  return {
    profile: 'product',
    toolsets: [],
    skills: [],
    enabled: true,
    discoveredAt: 0,
    ...overrides,
  }
}

function route(overrides: Partial<RoutingRule> = {}): RoutingRule {
  return {
    id: 'rt_1',
    name: 'Product review',
    priority: 10,
    enabled: true,
    trigger: { type: TRIGGER_TYPE.TICKET, provider: TICKET_PROVIDER.LINEAR, projectId: 'taplands' },
    match: {},
    target: { agentRef: { profile: 'product' } },
    execution: { prompt: 'Review {{ticket.ref}}', requireApproval: false, timeoutSeconds: 30 },
    outcome: { postComment: { target: COMMENT_TARGET.TICKET } },
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
    body: 'We need CSV.',
    labels: ['feasibility'],
    ...overrides,
  }
}

function makeOutcomes(): OutcomeHandlers & {
  comments: Array<{ target: string; body: string }>
  labelCalls: unknown[]
} {
  const comments: Array<{ target: string; body: string }> = []
  const labelCalls: unknown[] = []
  return {
    comments,
    labelCalls,
    postComment: async (target, _event, body) => {
      comments.push({ target, body })
    },
    updateLabels: async (_event, labels) => {
      labelCalls.push(labels)
    },
  }
}

async function makeDispatcher(
  fake: FakeHermes,
  options: {
    agents?: AgentDescriptor[]
    outcomes?: OutcomeHandlers
    ids?: string[]
  } = {}
) {
  const client = new HermesClient({ baseUrl: fake.baseUrl, profile: 'product', apiKey: 'k' })
  const adapter = new HermesAdapter(client, logger, { pollIntervalMs: 5 })
  const ids = options.ids ?? ['pxr_1', 'pxr_2', 'pxr_3']
  let index = 0

  return new Dispatcher({
    db,
    logger,
    lifecycle: new RunLifecycle(db, logger),
    outcomes: options.outcomes ?? makeOutcomes(),
    adapters: new Map([['product', adapter]]),
    agents: options.agents ?? [agent()],
    newRunId: () => ids[index++] ?? `pxr_${index}`,
  })
}

describe('Dispatcher.dispatch', () => {
  it('runs a matching route and records a completed run', async () => {
    server = await startFakeHermes({
      statuses: ['completed'],
      output: 'SENTINEL0_SUMMARY: Worth doing, two weeks.',
    })
    const outcomes = makeOutcomes()
    const dispatcher = await makeDispatcher(server, { outcomes })

    const result = await dispatcher.dispatch(event(), [route()])

    expect(result).toEqual({
      outcome: 'dispatched',
      runId: 'pxr_1',
      status: RUN_STATUS.COMPLETED,
    })
    const stored = db.getRun('pxr_1')
    expect(stored).toMatchObject({
      status: RUN_STATUS.COMPLETED,
      agentProfile: 'product',
      triggerRef: 'LIN-123',
      summary: 'Worth doing, two weeks.',
    })
    expect(stored?.endedAt).toBeGreaterThan(0)
  })

  it('posts the agent summary to the tracker', async () => {
    server = await startFakeHermes({
      statuses: ['completed'],
      output: 'SENTINEL0_SUMMARY: Feasible.',
    })
    const outcomes = makeOutcomes()

    await (await makeDispatcher(server, { outcomes })).dispatch(event(), [route()])

    expect(outcomes.comments).toEqual([{ target: COMMENT_TARGET.TICKET, body: 'Feasible.' }])
  })

  it('applies label outcomes', async () => {
    server = await startFakeHermes({ statuses: ['completed'] })
    const outcomes = makeOutcomes()
    const withLabels = route({
      outcome: { labels: { add: ['reviewed'], remove: ['feasibility'] } },
    })

    await (await makeDispatcher(server, { outcomes })).dispatch(event(), [withLabels])

    // The route's own label outcome, alongside the markers the guard applies.
    expect(outcomes.labelCalls).toContainEqual({ add: ['reviewed'], remove: ['feasibility'] })
  })

  it('skips when nothing matches, without creating a run', async () => {
    server = await startFakeHermes({})
    const dispatcher = await makeDispatcher(server)

    const result = await dispatcher.dispatch(event({ labels: [] }), [
      route({ match: { labels: { any: ['other'] } } }),
    ])

    expect(result).toEqual({ outcome: 'skipped', reason: 'no-route' })
    expect(db.listRuns()).toHaveLength(0)
  })

  it('fires once per item by default, even when the item changes', async () => {
    server = await startFakeHermes({ statuses: ['completed'] })
    const dispatcher = await makeDispatcher(server)

    const first = await dispatcher.dispatch(event(), [route()])
    const second = await dispatcher.dispatch(event(), [route()])
    // A changed revision must NOT re-fire: an agent acting on an item changes
    // it, so re-firing on change is how a route loops.
    const third = await dispatcher.dispatch(event({ revision: 'rev-2' }), [route()])

    expect(first.outcome).toBe('dispatched')
    expect(second).toEqual({ outcome: 'skipped', reason: 'duplicate' })
    expect(third).toEqual({ outcome: 'skipped', reason: 'duplicate' })
    expect(db.listRuns()).toHaveLength(1)
  })

  it('fires again on a change when the route asks for per-change', async () => {
    server = await startFakeHermes({ statuses: ['completed'] })
    const dispatcher = await makeDispatcher(server)
    const repeat = route({ guard: { refire: 'per-change', markers: false } })

    expect((await dispatcher.dispatch(event(), [repeat])).outcome).toBe('dispatched')
    expect(await dispatcher.dispatch(event(), [repeat])).toMatchObject({ reason: 'duplicate' })
    expect((await dispatcher.dispatch(event({ revision: 'rev-2' }), [repeat])).outcome).toBe(
      'dispatched'
    )
  })

  it('defers rather than running two agents against one profile', async () => {
    server = await startFakeHermes({ statuses: ['completed'] })
    const dispatcher = await makeDispatcher(server)

    // An in-flight run occupies the profile.
    db.createRun({
      id: 'existing',
      routeId: 'rt_other',
      routeName: 'other',
      agentProfile: 'product',
      projectId: 'taplands',
      triggerType: TRIGGER_TYPE.TICKET,
      triggerRef: 'LIN-999',
      triggerRevision: 'r',
      title: 't',
      status: RUN_STATUS.RUNNING,
      createdAt: 1,
      updatedAt: 1,
    })

    const result = await dispatcher.dispatch(event(), [route()])

    expect(result.outcome).toBe('skipped')
    expect(result).toMatchObject({ reason: 'agent-busy' })
  })

  it('leaves the trigger unclaimed when deferring, so it runs next cycle', async () => {
    server = await startFakeHermes({ statuses: ['completed'] })
    const dispatcher = await makeDispatcher(server)

    db.createRun({
      id: 'existing',
      routeId: 'rt_other',
      routeName: 'other',
      agentProfile: 'product',
      projectId: 'taplands',
      triggerType: TRIGGER_TYPE.TICKET,
      triggerRef: 'LIN-999',
      triggerRevision: 'r',
      title: 't',
      status: RUN_STATUS.RUNNING,
      createdAt: 1,
      updatedAt: 1,
    })
    await dispatcher.dispatch(event(), [route()])

    // The blocking run finishes; the same trigger must now be dispatchable.
    db.updateRun('existing', { status: RUN_STATUS.COMPLETED })
    const retry = await dispatcher.dispatch(event(), [route()])

    expect(retry.outcome).toBe('dispatched')
  })

  it('skips a route pointing at an agent that is not registered', async () => {
    server = await startFakeHermes({})
    const dispatcher = await makeDispatcher(server, { agents: [agent({ profile: 'coder' })] })

    const result = await dispatcher.dispatch(event(), [route()])

    expect(result).toMatchObject({ outcome: 'skipped', reason: 'unknown-agent' })
    expect(warnings.join(' ')).toContain('not a known enabled agent')
  })

  it('skips a route pointing at a disabled agent', async () => {
    server = await startFakeHermes({})
    const dispatcher = await makeDispatcher(server, { agents: [agent({ enabled: false })] })

    const result = await dispatcher.dispatch(event(), [route()])
    expect(result).toMatchObject({ outcome: 'skipped', reason: 'unknown-agent' })
  })

  it('resolves an agent by github login for reviewer-assignment routes', async () => {
    server = await startFakeHermes({ statuses: ['completed'] })
    const dispatcher = await makeDispatcher(server, {
      agents: [agent({ githubLogin: 'Acme-Bot' })],
    })

    const result = await dispatcher.dispatch(
      event({
        type: TRIGGER_TYPE.PR_REVIEW_REQUESTED,
        provider: TICKET_PROVIDER.GITHUB,
        requestedReviewers: ['acme-bot'],
      }),
      [
        route({
          trigger: { type: TRIGGER_TYPE.PR_REVIEW_REQUESTED, projectId: 'taplands' },
          target: { agentRef: { githubLogin: 'acme-bot' } },
          execution: {
            prompt: 'Review {{ticket.ref}}',
            requireApproval: false,
            timeoutSeconds: 30,
          },
        }),
      ]
    )

    expect(result.outcome).toBe('dispatched')
  })

  it('runs anyway when a prompt uses an unknown placeholder, and says so', async () => {
    server = await startFakeHermes({ statuses: ['completed'] })
    const dispatcher = await makeDispatcher(server)
    const typo = route({
      execution: {
        prompt: 'Review {{ticket.titel}}',
        requireApproval: false,
        timeoutSeconds: 30,
      },
    })

    const result = await dispatcher.dispatch(event(), [typo])

    // A typo should not block work; it should be visible.
    expect(result).toMatchObject({ outcome: 'dispatched', status: RUN_STATUS.COMPLETED })
    expect(warnings.join(' ')).toContain('unknown placeholder')
    expect(warnings.join(' ')).toContain('ticket.titel')
  })

  it('releases the claim when a route has no prompt at all, so a fix can run', async () => {
    server = await startFakeHermes({ statuses: ['completed'] })
    const dispatcher = await makeDispatcher(server)
    const broken = route({
      execution: { requireApproval: false, timeoutSeconds: 30 } as never,
    })

    const result = await dispatcher.dispatch(event(), [broken])

    expect(result).toMatchObject({ outcome: 'failed' })
    expect(db.listRuns()).toHaveLength(0)

    // Same route id and trigger: the corrected route is not suppressed as a duplicate.
    expect((await dispatcher.dispatch(event(), [route()])).outcome).toBe('dispatched')
  })

  it('records a failed run and tells the tracker about it', async () => {
    server = await startFakeHermes({ statuses: ['failed'], runError: 'tool crashed' })
    const outcomes = makeOutcomes()

    const result = await (await makeDispatcher(server, { outcomes })).dispatch(event(), [route()])

    expect(result).toMatchObject({ outcome: 'dispatched', status: RUN_STATUS.FAILED })
    expect(db.getRun('pxr_1')).toMatchObject({ status: RUN_STATUS.FAILED, error: 'tool crashed' })
    expect(outcomes.comments[0].body).toContain('Sentinel0 run failed: tool crashed')
  })

  it('does not fail a good run because an outcome handler threw', async () => {
    server = await startFakeHermes({
      statuses: ['completed'],
      output: 'SENTINEL0_SUMMARY: fine',
    })
    const outcomes = makeOutcomes()
    outcomes.postComment = vi.fn().mockRejectedValue(new Error('linear is down'))

    const result = await (await makeDispatcher(server, { outcomes })).dispatch(event(), [route()])

    expect(result).toMatchObject({ status: RUN_STATUS.COMPLETED })
    expect(db.getRun('pxr_1')?.status).toBe(RUN_STATUS.COMPLETED)
    expect(warnings.join(' ')).toContain('linear is down')
  })

  it('holds the marker through an approval and clears it when the run ends', async () => {
    server = await startFakeHermes({
      statuses: ['pending_approval', 'completed'],
      output: 'SENTINEL0_SUMMARY: approved and done',
    })
    const outcomes = makeOutcomes()

    const result = await (await makeDispatcher(server, { outcomes })).dispatch(event(), [route()])

    // An approval is a state the run passes through. Reporting it as the
    // dispatch's outcome stranded the run: the in-progress marker stayed on the
    // ticket forever, which makes the item unroutable by anything, and the
    // agent stayed occupied.
    expect(result).toMatchObject({ status: RUN_STATUS.COMPLETED })
    expect(db.countActiveRunsForAgent('product')).toBe(0)
    expect(JSON.stringify(outcomes.labelCalls)).toContain(SENTINEL0_LABEL.IN_PROGRESS)
  })

  it('records what the agent is waiting for, so a human can answer it', async () => {
    server = await startFakeHermes({ statuses: ['pending_approval'] })
    const dispatcher = await makeDispatcher(server, { outcomes: makeOutcomes() })

    // Left waiting on purpose: the assertion is about what is visible *while*
    // a person is deciding, which is the entire point of the state.
    void dispatcher.dispatch(event(), [route()])

    await vi.waitFor(() => {
      expect(db.getRun('pxr_1')?.status).toBe(RUN_STATUS.AWAITING_APPROVAL)
    })
    expect(db.countActiveRunsForAgent('product')).toBe(1)
  })
})

describe('cancellation wiring', () => {
  it('persists the hermes run id before the run finishes, so a cancel can reach it', async () => {
    server = await startFakeHermes({ statuses: ['running'] })
    const inFlight = new Map<string, AbortController>()
    const client = new HermesClient({ baseUrl: server.baseUrl, profile: 'product', apiKey: 'k' })
    const adapter = new HermesAdapter(client, logger, { pollIntervalMs: 20 })

    const dispatcher = new Dispatcher({
      db,
      logger,
      lifecycle: new RunLifecycle(db, logger),
      outcomes: makeOutcomes(),
      adapters: new Map([['product', adapter]]),
      agents: [agent()],
      newRunId: () => 'pxr_1',
      inFlight,
    })

    const pending = dispatcher.dispatch(event(), [route()])

    // Mid-run: the row already knows which Hermes run to stop, and the
    // controller is registered for a local abort.
    await vi.waitFor(() => {
      expect(db.getRun('pxr_1')?.hermesRunId).toBe('run_test_1')
      expect(inFlight.has('pxr_1')).toBe(true)
    })

    inFlight.get('pxr_1')!.abort()
    await pending

    // And the registry is cleaned up once the run settles.
    expect(inFlight.has('pxr_1')).toBe(false)
  })

  it('aborting the registered controller stops the run on the Hermes side', async () => {
    server = await startFakeHermes({ statuses: ['running'] })
    const inFlight = new Map<string, AbortController>()
    const client = new HermesClient({ baseUrl: server.baseUrl, profile: 'product', apiKey: 'k' })
    const adapter = new HermesAdapter(client, logger, { pollIntervalMs: 10 })

    const dispatcher = new Dispatcher({
      db,
      logger,
      lifecycle: new RunLifecycle(db, logger),
      outcomes: makeOutcomes(),
      adapters: new Map([['product', adapter]]),
      agents: [agent()],
      newRunId: () => 'pxr_1',
      inFlight,
    })

    const pending = dispatcher.dispatch(event(), [route()])

    // Wait until Hermes has acknowledged the run, so this exercises the normal
    // "cancel something that is genuinely running" path.
    await vi.waitFor(() => expect(db.getRun('pxr_1')?.hermesRunId).toBe('run_test_1'))
    inFlight.get('pxr_1')!.abort()

    const result = await pending

    expect(result).toMatchObject({ status: RUN_STATUS.CANCELED })
    expect(server!.stopCalls).toEqual(['run_test_1'])
    expect(db.getRun('pxr_1')?.status).toBe(RUN_STATUS.CANCELED)
  })

  it('reports a possible orphan when aborted before Hermes acknowledged the run', async () => {
    server = await startFakeHermes({ statuses: ['running'] })
    const inFlight = new Map<string, AbortController>()
    const client = new HermesClient({ baseUrl: server.baseUrl, profile: 'product', apiKey: 'k' })
    const adapter = new HermesAdapter(client, logger, { pollIntervalMs: 10 })

    const dispatcher = new Dispatcher({
      db,
      logger,
      lifecycle: new RunLifecycle(db, logger),
      outcomes: makeOutcomes(),
      adapters: new Map([['product', adapter]]),
      agents: [agent()],
      newRunId: () => 'pxr_1',
      inFlight,
    })

    const pending = dispatcher.dispatch(event(), [route()])
    // Abort in the window before Hermes has answered POST /v1/runs at all.
    await vi.waitFor(() => expect(inFlight.has('pxr_1')).toBe(true))
    inFlight.get('pxr_1')!.abort()

    const result = await pending

    expect(result).toMatchObject({ status: RUN_STATUS.CANCELED })
    // Nothing identifies the run, so we say so rather than pretending it stopped.
    expect(warnings.join(' ')).toContain('may be orphaned')
  })
})

describe('routing decisions are reported before the run', () => {
  it('reports every skip reason, including the silent ones', async () => {
    server = await startFakeHermes({ statuses: ['completed'] })
    const dispatcher = await makeDispatcher(server)
    const seen: string[] = []
    const record = (d: { outcome: string; reason?: string }) => seen.push(d.reason ?? d.outcome)

    // no-route: the case that used to produce no output at all.
    await dispatcher.dispatch(
      event({ labels: [] }),
      [route({ match: { labels: { any: ['nope'] } } })],
      record
    )

    await dispatcher.dispatch(event(), [route()], record) // started
    await dispatcher.dispatch(event(), [route()], record) // duplicate

    expect(seen).toEqual(['no-route', 'started', 'duplicate'])
  })

  it('reports the decision before the agent run finishes', async () => {
    server = await startFakeHermes({ statuses: ['running'] })
    const inFlight = new Map<string, AbortController>()
    const client = new HermesClient({ baseUrl: server.baseUrl, profile: 'product', apiKey: 'k' })
    const adapter = new HermesAdapter(client, logger, { pollIntervalMs: 10 })

    const dispatcher = new Dispatcher({
      db,
      logger,
      lifecycle: new RunLifecycle(db, logger),
      outcomes: makeOutcomes(),
      adapters: new Map([['product', adapter]]),
      agents: [agent()],
      newRunId: () => 'pxr_1',
      inFlight,
    })

    const decisions: string[] = []
    const pending = dispatcher.dispatch(event(), [route()], (d) => decisions.push(d.outcome))

    // The run is still going, but routing has already been reported -- which is
    // what lets a per-cycle summary count it without waiting half an hour.
    await vi.waitFor(() => expect(decisions).toEqual(['started']))

    inFlight.get('pxr_1')!.abort()
    await pending
  })
})

/**
 * A manual prompt is the one path with no route, no trigger and no tracker item
 * behind it. What matters is that it still produces an ordinary run — the
 * dashboard, the cloud mirror and Slack all read the same record — while
 * skipping every step that only makes sense for a routed one.
 */
describe('Dispatcher.dispatchPrompt', () => {
  it('runs the named agent and records an ordinary completed run', async () => {
    server = await startFakeHermes({
      statuses: ['completed'],
      output: 'SENTINEL0_SUMMARY: Done.',
    })
    const dispatcher = await makeDispatcher(server)

    const result = await dispatcher.dispatchPrompt({
      agentProfile: 'product',
      prompt: 'Summarise this week',
    })

    expect(result).toEqual({
      outcome: 'dispatched',
      runId: 'pxr_1',
      status: RUN_STATUS.COMPLETED,
    })
    expect(db.getRun('pxr_1')).toMatchObject({
      status: RUN_STATUS.COMPLETED,
      agentProfile: 'product',
      triggerType: TRIGGER_TYPE.MANUAL,
      summary: 'Done.',
    })
  })

  it('sends the prompt through verbatim, with no template rendering', async () => {
    server = await startFakeHermes({ statuses: ['completed'] })
    const dispatcher = await makeDispatcher(server)

    // A brace pair is a route placeholder, and rendering one here would either
    // blank it or leave a warning about an unknown variable. An operator's own
    // text is not a template.
    const prompt = 'Explain {{ticket.ref}} to me'
    await dispatcher.dispatchPrompt({ agentProfile: 'product', prompt })

    expect(server.createdBodies[0]).toMatchObject({ input: prompt })
  })

  it('titles the run from the prompt when no title is given', async () => {
    server = await startFakeHermes({ statuses: ['completed'] })
    const dispatcher = await makeDispatcher(server)

    await dispatcher.dispatchPrompt({
      agentProfile: 'product',
      prompt: 'Audit the billing export\n\nand then check the invoices',
    })

    // The first line, not the whole prompt: a run list is a column, not a page.
    expect(db.getRun('pxr_1')?.title).toBe('Audit the billing export')
  })

  it('prefers an explicit title', async () => {
    server = await startFakeHermes({ statuses: ['completed'] })
    const dispatcher = await makeDispatcher(server)

    await dispatcher.dispatchPrompt({
      agentProfile: 'product',
      prompt: 'Audit the billing export',
      title: 'Billing audit',
    })

    expect(db.getRun('pxr_1')?.title).toBe('Billing audit')
  })

  it('truncates a long first line rather than storing a paragraph as a title', async () => {
    server = await startFakeHermes({ statuses: ['completed'] })
    const dispatcher = await makeDispatcher(server)

    await dispatcher.dispatchPrompt({ agentProfile: 'product', prompt: 'x'.repeat(200) })

    const title = db.getRun('pxr_1')!.title
    expect(title).toHaveLength(80)
    expect(title.endsWith('…')).toBe(true)
  })

  it('refuses an unknown agent instead of starting anything', async () => {
    server = await startFakeHermes({ statuses: ['completed'] })
    const dispatcher = await makeDispatcher(server)

    const result = await dispatcher.dispatchPrompt({ agentProfile: 'ghost', prompt: 'hello' })

    expect(result).toMatchObject({ outcome: 'skipped', reason: 'unknown-agent' })
    expect(db.getRun('pxr_1')).toBeUndefined()
  })

  it('refuses a disabled agent', async () => {
    server = await startFakeHermes({ statuses: ['completed'] })
    const dispatcher = await makeDispatcher(server, { agents: [agent({ enabled: false })] })

    const result = await dispatcher.dispatchPrompt({ agentProfile: 'product', prompt: 'hello' })

    expect(result).toMatchObject({ outcome: 'skipped', reason: 'unknown-agent' })
  })

  /**
   * The one invariant a manual run cannot be allowed to break: Hermes corrupts
   * a profile's memory when two runs drive it at once. A routed trigger defers
   * and returns next cycle; nothing will retry this, so it is refused outright
   * and the reason is reported.
   */
  it('refuses to start a second run on a busy agent', async () => {
    server = await startFakeHermes({ statuses: ['running'] })
    const dispatcher = await makeDispatcher(server, { ids: ['pxr_1', 'pxr_2'] })

    const inFlight = dispatcher.dispatchPrompt({ agentProfile: 'product', prompt: 'first' })
    await vi.waitFor(() => expect(db.getRun('pxr_1')?.status).toBe(RUN_STATUS.RUNNING))

    const second = await dispatcher.dispatchPrompt({ agentProfile: 'product', prompt: 'second' })

    expect(second).toMatchObject({ outcome: 'skipped', reason: 'agent-busy' })
    expect(db.getRun('pxr_2')).toBeUndefined()

    // Let the first run finish so the fake server can shut down cleanly.
    server.close()
    await inFlight.catch(() => undefined)
  })

  it('claims nothing in the dispatch ledger', async () => {
    server = await startFakeHermes({ statuses: ['completed'] })
    const dispatcher = await makeDispatcher(server)

    await dispatcher.dispatchPrompt({ agentProfile: 'product', prompt: 'run me' })

    // The ledger stops an unchanged *ticket* re-firing every poll cycle. A
    // person pressing the button twice means it twice, so pressing it again
    // must not be silently swallowed as a duplicate.
    const again = await dispatcher.dispatchPrompt({ agentProfile: 'product', prompt: 'run me' })
    expect(again).toMatchObject({ outcome: 'dispatched' })
  })

  it('records a failure as a failed run rather than throwing', async () => {
    server = await startFakeHermes({ statuses: ['failed'], runError: 'model unavailable' })
    const dispatcher = await makeDispatcher(server)

    const result = await dispatcher.dispatchPrompt({ agentProfile: 'product', prompt: 'go' })

    expect(result).toMatchObject({ outcome: 'dispatched', status: RUN_STATUS.FAILED })
    expect(db.getRun('pxr_1')).toMatchObject({
      status: RUN_STATUS.FAILED,
      error: 'model unavailable',
    })
  })
})
