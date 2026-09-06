import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RUN_LOG_KIND,
  RUN_STATUS,
  type Logger,
  type RunApprovalDetail,
  type RunLogKind,
} from '@sentinel0/common'
import { HermesClient } from '../../src/hermes/client.js'
import { HermesAdapter, mapHermesStatus } from '../../src/hermes/adapter.js'
import { startFakeHermes, type FakeHermes } from './fake-hermes-server.js'

interface Captured {
  kind: RunLogKind
  message: string
}

function makeLogger(): { logger: Logger; events: Captured[]; warnings: string[] } {
  const events: Captured[] = []
  const warnings: string[] = []
  const logger: Logger = {
    info: () => undefined,
    success: () => undefined,
    warn: (msg) => warnings.push(msg),
    error: () => undefined,
    event: (entry) => events.push({ kind: entry.kind, message: entry.message }),
  }
  return { logger, events, warnings }
}

const JOB = {
  runId: 'pxr_1',
  prompt: 'review this',
  timeoutSeconds: 30,
}

let server: FakeHermes | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
})

function adapterFor(fake: FakeHermes, logger: Logger, profile = 'default') {
  const client = new HermesClient({ baseUrl: fake.baseUrl, profile, apiKey: 'k' })
  return new HermesAdapter(client, logger, { pollIntervalMs: 5 })
}

describe('mapHermesStatus', () => {
  it('normalizes British cancellation to the Sentinel0 spelling', () => {
    expect(mapHermesStatus('cancelled')).toBe(RUN_STATUS.CANCELED)
    expect(mapHermesStatus('canceled')).toBe(RUN_STATUS.CANCELED)
  })

  it('maps the terminal and pending statuses', () => {
    expect(mapHermesStatus('completed')).toBe(RUN_STATUS.COMPLETED)
    expect(mapHermesStatus('failed')).toBe(RUN_STATUS.FAILED)
    expect(mapHermesStatus('expired')).toBe(RUN_STATUS.FAILED)
    expect(mapHermesStatus('pending_approval')).toBe(RUN_STATUS.AWAITING_APPROVAL)
    expect(mapHermesStatus('in_progress')).toBe(RUN_STATUS.RUNNING)
  })
})

describe('HermesAdapter.run', () => {
  it('completes a run and returns its output, usage, and session', async () => {
    server = await startFakeHermes({
      statuses: ['running', 'completed'],
      output: 'the review',
      usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
      sessionId: 'sess_9',
    })
    const { logger } = makeLogger()

    const outcome = await adapterFor(server, logger).run(JOB)

    expect(outcome.status).toBe(RUN_STATUS.COMPLETED)
    expect(outcome.hermesRunId).toBe('run_test_1')
    expect(outcome.output).toBe('the review')
    expect(outcome.usage).toEqual({ inputTokens: 10, outputTokens: 20, totalTokens: 30 })
    expect(outcome.sessionId).toBe('sess_9')
  })

  it('forwards stream events into the log pipeline', async () => {
    server = await startFakeHermes({
      statuses: ['running', 'running', 'completed'],
      events: [
        { event: 'tool.started', data: { name: 'terminal', arguments: 'ls' } },
        { event: 'assistant.delta', data: { delta: 'looking' } },
      ],
    })
    const { logger, events } = makeLogger()

    await adapterFor(server, logger).run(JOB)

    expect(events.map((entry) => entry.kind)).toContain(RUN_LOG_KIND.COMMAND)
    expect(events.map((entry) => entry.message)).toContain('looking')
  })

  it('completes even when the event stream is unavailable', async () => {
    server = await startFakeHermes({ statuses: ['completed'], eventsStatus: 500 })
    const { logger, warnings } = makeLogger()

    const outcome = await adapterFor(server, logger).run(JOB)

    // The stream is progress, not truth: losing it degrades logs, not the run.
    expect(outcome.status).toBe(RUN_STATUS.COMPLETED)
    expect(warnings.join(' ')).toContain('event stream')
  })

  it('rides out transient poll failures rather than failing the run', async () => {
    server = await startFakeHermes({ statuses: ['completed'], failPollsBefore: 2 })
    const { logger, warnings } = makeLogger()

    const outcome = await adapterFor(server, logger).run(JOB)

    expect(outcome.status).toBe(RUN_STATUS.COMPLETED)
    expect(warnings.join(' ')).toContain('status poll failed')
  })

  it('stops the run and fails it when the timeout elapses', async () => {
    server = await startFakeHermes({ statuses: ['running'] })
    const { logger } = makeLogger()

    const outcome = await adapterFor(server, logger).run({ ...JOB, timeoutSeconds: 0.05 })

    expect(outcome.status).toBe(RUN_STATUS.FAILED)
    expect(outcome.error).toContain('timeout')
    expect(server.stopCalls).toEqual(['run_test_1'])
  })

  it('stops the run on abort and reports it canceled', async () => {
    server = await startFakeHermes({ statuses: ['running'] })
    const { logger } = makeLogger()
    const controller = new AbortController()

    const pending = adapterFor(server, logger).run(JOB, controller.signal)

    // Wait for Hermes to have accepted the run rather than guessing with a
    // timer: aborting before that lands in a different branch, one where there
    // is no run id to stop yet, and the assertion below would race.
    await vi.waitFor(() => expect(server!.createdBodies).toHaveLength(1))
    controller.abort()

    const outcome = await pending

    expect(outcome.status).toBe(RUN_STATUS.CANCELED)
    expect(server.stopCalls).toEqual(['run_test_1'])
  })

  it('waits at an approval gate and carries on once it is answered', async () => {
    // The gate opens on the second poll, as it would when a human answers.
    server = await startFakeHermes({ statuses: ['pending_approval', 'running', 'completed'] })
    const { logger } = makeLogger()
    const required: RunApprovalDetail[] = []
    let resolved = 0

    const outcome = await adapterFor(server, logger).run({
      ...JOB,
      onApprovalRequired: (detail) => required.push(detail),
      onApprovalResolved: () => {
        resolved += 1
      },
    })

    // The run must finish. Returning AWAITING_APPROVAL here -- which this did
    // until the gate could be answered -- abandons a live run: nothing polls it
    // again, so it holds its agent until someone cancels it by hand.
    expect(outcome.status).toBe(RUN_STATUS.COMPLETED)
    expect(required).toHaveLength(1)
    expect(resolved).toBe(1)
    expect(server.stopCalls).toEqual([])
  })

  it('reports each edge of the gate exactly once, however long the wait', async () => {
    server = await startFakeHermes({
      statuses: ['pending_approval', 'pending_approval', 'pending_approval', 'completed'],
    })
    const { logger } = makeLogger()
    let required = 0

    await adapterFor(server, logger).run({
      ...JOB,
      onApprovalRequired: () => {
        required += 1
      },
    })

    expect(required).toBe(1)
  })

  it('denies and stops a gate nobody answers in time', async () => {
    server = await startFakeHermes({ statuses: ['pending_approval'] })
    const { logger } = makeLogger()

    const outcome = await adapterFor(server, logger).run({
      ...JOB,
      // A tenth of a second stands in for the hour this defaults to.
      approvalTimeoutSeconds: 0.1,
    })

    expect(outcome.status).toBe(RUN_STATUS.FAILED)
    expect(outcome.error).toContain('not answered')
    // Denied first, then stopped: leaving a gate open on the Hermes side keeps
    // the agent sitting there after Sentinel0 has written the run off.
    expect(server.approvalCalls).toEqual([{ runId: 'run_test_1', body: { choice: 'deny' } }])
    expect(server.stopCalls).toEqual(['run_test_1'])
  })

  it('does not spend the run budget while a human is deciding', async () => {
    // Two seconds of gate against a one-second run timeout: if waiting counted
    // against the run, this would fail on the timeout rather than complete.
    server = await startFakeHermes({
      statuses: [...Array(12).fill('pending_approval'), 'completed'],
    })
    const { logger } = makeLogger()

    const outcome = await adapterFor(server, logger).run({
      ...JOB,
      timeoutSeconds: 1,
      approvalTimeoutSeconds: 30,
    })

    expect(outcome.status).toBe(RUN_STATUS.COMPLETED)
  })

  it('reports a failed run with the error Hermes gave', async () => {
    server = await startFakeHermes({ statuses: ['failed'], runError: 'tool crashed' })
    const { logger } = makeLogger()

    const outcome = await adapterFor(server, logger).run(JOB)

    expect(outcome.status).toBe(RUN_STATUS.FAILED)
    expect(outcome.error).toBe('tool crashed')
  })

  it('passes model and session overrides through to Hermes', async () => {
    server = await startFakeHermes({ statuses: ['completed'] })
    const { logger } = makeLogger()

    await adapterFor(server, logger).run({ ...JOB, model: 'MiniMax-M3', sessionId: 'sess_prev' })

    expect(server.createdBodies[0]).toMatchObject({
      input: 'review this',
      model: 'MiniMax-M3',
      session_id: 'sess_prev',
    })
  })

  it('omits optional fields rather than sending nulls', async () => {
    server = await startFakeHermes({ statuses: ['completed'] })
    const { logger } = makeLogger()

    await adapterFor(server, logger).run({ ...JOB, model: null })

    expect(server.createdBodies[0]).toEqual({ input: 'review this' })
  })
})

describe('HermesClient profile addressing', () => {
  it('prefixes named profiles and presents that profile key', async () => {
    server = await startFakeHermes({
      statuses: ['completed'],
      expectPrefix: '/p/product',
      requireBearer: 'product-key',
    })
    const client = new HermesClient({
      baseUrl: server.baseUrl,
      profile: 'product',
      apiKey: 'product-key',
    })

    await expect(client.capabilities()).resolves.toMatchObject({ platform: 'hermes-agent' })
  })

  it('leaves the default profile unprefixed', async () => {
    server = await startFakeHermes({ statuses: ['completed'] })
    const client = new HermesClient({ baseUrl: server.baseUrl, profile: 'default', apiKey: 'k' })

    await client.capabilities()

    expect(server.requests).toContain('GET /v1/capabilities')
  })

  it('refuses to construct without a key, since a named profile would 401 anyway', () => {
    expect(() => new HermesClient({ baseUrl: 'http://x', profile: 'product', apiKey: '' })).toThrow(
      /API key is required/
    )
  })

  it('raises a labelled error carrying status, profile, and path', async () => {
    server = await startFakeHermes({ createStatus: 429, expectPrefix: '/p/product' })
    const client = new HermesClient({ baseUrl: server.baseUrl, profile: 'product', apiKey: 'k' })

    await expect(client.createRun({ input: 'x' })).rejects.toThrow(
      /Hermes 429 on profile "product"/
    )
  })
})
