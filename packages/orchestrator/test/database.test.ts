import { beforeEach, describe, expect, it } from 'vitest'
import {
  RUN_LOG_KIND,
  RUN_LOG_LEVEL,
  RUN_LOG_SOURCE,
  RUN_STATUS,
  TRIGGER_TYPE,
  type RunLogEntry,
  type RunRecord,
} from '@sentinel0/common'
import { openDatabase, type Sentinel0Database } from '../src/database.js'

let db: Sentinel0Database

beforeEach(() => {
  db = openDatabase('memory')
})

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'pxr_1',
    routeId: 'rt_1',
    routeName: 'Product review',
    agentProfile: 'product',
    projectId: 'taplands',
    triggerType: TRIGGER_TYPE.TICKET,
    triggerRef: 'LIN-123',
    triggerRevision: 'rev-1',
    title: 'Add billing export',
    status: RUN_STATUS.QUEUED,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  }
}

function event(overrides: Partial<RunLogEntry> = {}): RunLogEntry {
  return {
    message: 'hello',
    icon: '.',
    level: RUN_LOG_LEVEL.INFO,
    timestamp: 5,
    kind: RUN_LOG_KIND.LIFECYCLE,
    source: RUN_LOG_SOURCE.SYSTEM,
    ...overrides,
  }
}

describe('runs', () => {
  it('round-trips a run', () => {
    db.createRun(run({ triggerUrl: 'https://linear.app/x' }))
    expect(db.getRun('pxr_1')).toMatchObject({
      id: 'pxr_1',
      agentProfile: 'product',
      triggerUrl: 'https://linear.app/x',
      status: RUN_STATUS.QUEUED,
    })
  })

  it('returns undefined for an unknown run', () => {
    expect(db.getRun('nope')).toBeUndefined()
  })

  it('applies a partial patch without clobbering untouched columns', () => {
    db.createRun(run({ summary: undefined }))
    db.updateRun('pxr_1', { status: RUN_STATUS.RUNNING, startedAt: 2000 }, 2000)
    db.updateRun('pxr_1', { summary: 'looks fine' }, 3000)

    const stored = db.getRun('pxr_1')
    expect(stored).toMatchObject({
      status: RUN_STATUS.RUNNING,
      startedAt: 2000,
      summary: 'looks fine',
      updatedAt: 3000,
    })
  })

  it('serializes usage as json and reads it back', () => {
    db.createRun(run())
    db.updateRun('pxr_1', { usage: { inputTokens: 5, totalTokens: 9 } })
    expect(db.getRun('pxr_1')?.usage).toEqual({ inputTokens: 5, totalTokens: 9 })
  })

  it('lists newest first and honours filters', () => {
    db.createRun(run({ id: 'a', updatedAt: 10 }))
    db.createRun(run({ id: 'b', updatedAt: 30, projectId: 'other' }))
    db.createRun(run({ id: 'c', updatedAt: 20, status: RUN_STATUS.FAILED }))

    expect(db.listRuns().map((entry) => entry.id)).toEqual(['b', 'c', 'a'])
    expect(db.listRuns({ projectId: 'other' }).map((entry) => entry.id)).toEqual(['b'])
    expect(db.listRuns({ status: RUN_STATUS.FAILED }).map((entry) => entry.id)).toEqual(['c'])
    expect(db.listRuns({ limit: 1 }).map((entry) => entry.id)).toEqual(['b'])
  })
})

describe('per-agent concurrency accounting', () => {
  it('counts only runs that still occupy the agent', () => {
    db.createRun(run({ id: 'a', status: RUN_STATUS.RUNNING }))
    db.createRun(run({ id: 'b', status: RUN_STATUS.AWAITING_APPROVAL }))
    db.createRun(run({ id: 'c', status: RUN_STATUS.COMPLETED }))
    db.createRun(run({ id: 'd', status: RUN_STATUS.FAILED }))
    db.createRun(run({ id: 'e', status: RUN_STATUS.CANCELED }))

    expect(db.countActiveRunsForAgent('product')).toBe(2)
  })

  it('scopes the count to one profile', () => {
    db.createRun(run({ id: 'a', agentProfile: 'product', status: RUN_STATUS.RUNNING }))
    db.createRun(run({ id: 'b', agentProfile: 'coder', status: RUN_STATUS.RUNNING }))

    expect(db.countActiveRunsForAgent('product')).toBe(1)
    expect(db.countActiveRunsForAgent('reviewer')).toBe(0)
  })

  it('lists unfinished runs oldest first, for restart recovery', () => {
    db.createRun(run({ id: 'new', createdAt: 20, status: RUN_STATUS.RUNNING }))
    db.createRun(run({ id: 'old', createdAt: 10, status: RUN_STATUS.QUEUED }))
    db.createRun(run({ id: 'done', createdAt: 5, status: RUN_STATUS.COMPLETED }))

    expect(db.listUnfinishedRuns().map((entry) => entry.id)).toEqual(['old', 'new'])
  })
})

describe('run events', () => {
  it('appends and reads back in timestamp order', () => {
    db.createRun(run())
    db.appendRunEvent('pxr_1', event({ message: 'second', timestamp: 20 }))
    db.appendRunEvent('pxr_1', event({ message: 'first', timestamp: 10 }))

    expect(db.listRunEvents('pxr_1').map((entry) => entry.message)).toEqual(['first', 'second'])
  })

  it('filters by since', () => {
    db.createRun(run())
    db.appendRunEvent('pxr_1', event({ message: 'old', timestamp: 10 }))
    db.appendRunEvent('pxr_1', event({ message: 'new', timestamp: 30 }))

    expect(db.listRunEvents('pxr_1', { since: 20 }).map((entry) => entry.message)).toEqual(['new'])
  })

  it('keys events on the run id, not some other identifier', () => {
    db.createRun(run({ id: 'pxr_1', triggerRef: 'LIN-123' }))
    db.appendRunEvent('pxr_1', event())

    expect(db.listRunEvents('pxr_1')).toHaveLength(1)
    expect(db.listRunEvents('LIN-123')).toHaveLength(0)
  })

  it('preserves optional fields as undefined rather than null', () => {
    db.createRun(run())
    db.appendRunEvent('pxr_1', event({ title: undefined, groupId: undefined }))

    const [stored] = db.listRunEvents('pxr_1')
    expect(stored.title).toBeUndefined()
    expect(stored.groupId).toBeUndefined()
  })
})

describe('dispatch ledger', () => {
  const claim = { runId: 'pxr_1', routeId: 'rt_1', triggerRef: 'LIN-123' }

  it('lets the first claim through and rejects the rest', () => {
    expect(db.claimDispatch('key-1', claim)).toBe(true)
    expect(db.claimDispatch('key-1', { ...claim, runId: 'pxr_2' })).toBe(false)
    expect(db.claimDispatch('key-2', claim)).toBe(true)
  })

  it('reports whether a key was already claimed', () => {
    expect(db.hasDispatched('key-1')).toBe(false)
    db.claimDispatch('key-1', claim)
    expect(db.hasDispatched('key-1')).toBe(true)
  })

  it('releases a claim so a transient failure does not suppress the trigger forever', () => {
    db.claimDispatch('key-1', claim)
    db.releaseDispatch('key-1')

    expect(db.hasDispatched('key-1')).toBe(false)
    expect(db.claimDispatch('key-1', claim)).toBe(true)
  })

  it('prunes only rows older than the cutoff', () => {
    db.claimDispatch('old', claim, 100)
    db.claimDispatch('recent', claim, 900)

    expect(db.pruneDispatchLedger(500)).toBe(1)
    expect(db.hasDispatched('old')).toBe(false)
    expect(db.hasDispatched('recent')).toBe(true)
  })
})

describe('project watermark', () => {
  it('is undefined until a project has been watched', () => {
    expect(db.watermarkFor('trackside')).toBeUndefined()
  })

  it('moves forward', () => {
    db.advanceWatermark('trackside', '2026-09-07T12:00:00Z')
    db.advanceWatermark('trackside', '2026-09-07T13:00:00Z')

    expect(db.watermarkFor('trackside')).toBe('2026-09-07T13:00:00Z')
  })

  it('never moves back, so a reopened item cannot make the backlog look new', () => {
    db.advanceWatermark('trackside', '2026-09-07T13:00:00Z')
    db.advanceWatermark('trackside', '2026-09-07T12:00:00Z')

    expect(db.watermarkFor('trackside')).toBe('2026-09-07T13:00:00Z')
  })

  it('ignores an absent timestamp rather than clearing what it has', () => {
    db.advanceWatermark('trackside', '2026-09-07T13:00:00Z')
    db.advanceWatermark('trackside', undefined)

    expect(db.watermarkFor('trackside')).toBe('2026-09-07T13:00:00Z')
  })

  it('keeps projects apart', () => {
    db.advanceWatermark('trackside', '2026-09-07T13:00:00Z')
    expect(db.watermarkFor('other')).toBeUndefined()
  })
})
