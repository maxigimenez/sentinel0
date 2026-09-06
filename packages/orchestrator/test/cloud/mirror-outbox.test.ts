import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RUN_STATUS, type RunRecord } from '@sentinel0/common'
import { CloudClient, MirrorOutbox } from '../../src/cloud/client.js'
import { openDatabase, type Sentinel0Database } from '../../src/database.js'

const config = {
  baseUrl: 'https://cloud.example',
  apiKey: 'snt_rnr_test',
  runnerName: 'cerebro',
}

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'pxr_1',
    routeId: 'rt_1',
    routeName: 'Assess',
    agentProfile: 'product',
    projectId: 'acme/api',
    triggerType: 'ticket',
    triggerRef: 'ACME-1',
    triggerRevision: 'rev-1',
    title: 'A ticket',
    status: RUN_STATUS.QUEUED,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

let db: Sentinel0Database
let sent: string[]
let failing: boolean

beforeEach(() => {
  db = openDatabase('memory')
  sent = []
  failing = false
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      if (failing) {
        throw new Error('cloud is down')
      }
      sent.push(String(url))
      return new Response(null, { status: 204 })
    })
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  db.close()
})

function outboxFor(errors: string[] = []): MirrorOutbox {
  return new MirrorOutbox(new CloudClient(config), db, (message) => errors.push(message), {
    debounceMs: 1,
    backoffMs: 5,
  })
}

describe('MirrorOutbox', () => {
  it('sends a run without waiting to be flushed', async () => {
    const outbox = outboxFor()
    outbox.enqueue({ kind: 'run', run: run() })

    // Nothing calls flush here. The previous outbox was drained by the poll
    // loop, whose last act is a 25-second long poll, so a status change took
    // most of a minute to reach the only screen that works off this network.
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]).toContain('/v1/runner/runs?runner=cerebro')
    expect(outbox.size).toBe(0)
    outbox.stop()
  })

  it('keeps what it could not send, across a process restart', async () => {
    failing = true
    const errors: string[] = []
    const first = outboxFor(errors)
    first.enqueue({ kind: 'run', run: run() })
    first.enqueue({ kind: 'run-update', run: run({ status: RUN_STATUS.COMPLETED }) })

    await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0))
    expect(first.size).toBe(2)
    first.stop()

    // A new process, the same database: the old outbox lived in memory, so a
    // restart during a cloud outage left a finished run reading "running" in
    // the cloud forever.
    failing = false
    const second = outboxFor()
    second.start()

    await vi.waitFor(() => expect(second.size).toBe(0))
    expect(sent).toHaveLength(2)
    second.stop()
  })

  it('preserves order, so an update cannot overtake its own creation', async () => {
    const outbox = outboxFor()
    outbox.enqueue({ kind: 'run', run: run() })
    outbox.enqueue({ kind: 'events', runId: 'pxr_1', events: [] })
    outbox.enqueue({ kind: 'run-update', run: run({ status: RUN_STATUS.COMPLETED }) })

    await vi.waitFor(() => expect(sent).toHaveLength(3))
    expect(sent[0]).toContain('/v1/runner/runs?')
    expect(sent[1]).toContain('/events?')
    expect(sent[2]).toContain('/v1/runner/runs/pxr_1?')
    outbox.stop()
  })

  it('says so when it drops a backlog rather than dropping it silently', async () => {
    failing = true
    const errors: string[] = []
    const outbox = new MirrorOutbox(
      new CloudClient(config),
      db,
      (message) => errors.push(message),
      { debounceMs: 1, backoffMs: 5, maxPending: 2 }
    )

    outbox.enqueue({ kind: 'run', run: run({ id: 'pxr_1' }) })
    outbox.enqueue({ kind: 'run', run: run({ id: 'pxr_2' }) })
    outbox.enqueue({ kind: 'run', run: run({ id: 'pxr_3' }) })

    expect(outbox.size).toBe(2)
    expect(errors.join(' ')).toContain('dropped 1 oldest write')
    outbox.stop()
  })
})
