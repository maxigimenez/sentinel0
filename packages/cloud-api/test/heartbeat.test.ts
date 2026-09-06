import { beforeAll, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import { hashKey } from '../src/auth.js'
import type { Database } from '../src/db.js'

beforeAll(() => {
  process.env.LOG_LEVEL = 'silent'
})

const RUNNER_KEY = 'snt_rnr_daemon'
const USER_KEY = 'snt_usr_human'

interface Recorded {
  sql: string
  params: unknown[]
}

function fakeDb(updateRowCount = 1): Database & { calls: Recorded[] } {
  const calls: Recorded[] = []
  const db = {
    calls,
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params })
      if (sql.includes('FROM api_keys WHERE key_hash')) {
        const rows =
          params[0] === hashKey(RUNNER_KEY)
            ? [{ id: 'key_r', org_id: 'org_1', scope: 'runner', revoked_at: null }]
            : params[0] === hashKey(USER_KEY)
              ? [{ id: 'key_u', org_id: 'org_1', scope: 'user', revoked_at: null }]
              : []
        return { rows, rowCount: rows.length }
      }
      if (sql.trimStart().startsWith('UPDATE runners')) {
        return { rows: [], rowCount: updateRowCount }
      }
      return { rows: [], rowCount: 0 }
    }),
  }
  return db as unknown as Database & { calls: Recorded[] }
}

const beat = (body: unknown, key = RUNNER_KEY) => ({
  method: 'POST' as const,
  url: '/v1/runner/heartbeat',
  headers: { authorization: `Bearer ${key}` },
  payload: body,
})

describe('POST /v1/runner/heartbeat', () => {
  it('records the health a runner reports', async () => {
    const db = fakeDb()
    const app = await buildApp(db)

    const response = await app.inject(
      beat({
        name: 'cerebro',
        startedAt: '2026-09-01T00:00:00.000Z',
        hermesOk: true,
        hermesDetail: 'hermes-4-70b',
        activeRuns: 2,
        lastError: null,
      })
    )

    expect(response.statusCode).toBe(200)
    const update = db.calls.find((call) => call.sql.includes('SET last_seen_at      = now()'))
    expect(update?.params).toEqual([
      'org_1',
      'cerebro',
      '2026-09-01T00:00:00.000Z',
      true,
      'hermes-4-70b',
      2,
      null,
      null,
    ])
    await app.close()
  })

  /**
   * A runner built before the heartbeat existed sends none of these fields. It
   * must still register as alive rather than failing, and its health must read
   * as "not reported" rather than as a failure.
   */
  it('accepts a heartbeat carrying only a name', async () => {
    const db = fakeDb()
    const app = await buildApp(db)
    const response = await app.inject(beat({ name: 'cerebro' }))
    expect(response.statusCode).toBe(200)

    const update = db.calls.find((call) => call.sql.includes('SET last_seen_at      = now()'))
    expect(update?.params.slice(2)).toEqual([null, null, null, null, null, null])
    await app.close()
  })

  it('requires a name to know which runner is speaking', async () => {
    const app = await buildApp(fakeDb())
    expect((await app.inject(beat({}))).statusCode).toBe(400)
    await app.close()
  })

  // Otherwise a runner whose row was deleted heartbeats into the void forever.
  it('reports an unknown runner rather than silently doing nothing', async () => {
    const app = await buildApp(fakeDb(0))
    const response = await app.inject(beat({ name: 'ghost' }))
    expect(response.statusCode).toBe(404)
    expect(response.json().error).toMatch(/not registered/)
    await app.close()
  })

  it('refuses a user key', async () => {
    const app = await buildApp(fakeDb())
    expect((await app.inject(beat({ name: 'cerebro' }, USER_KEY))).statusCode).toBe(401)
    await app.close()
  })
})

describe('runner liveness', () => {
  /**
   * The heartbeat is not the only proof of life. The command long-poll runs
   * every ~25 seconds regardless, so touching last_seen_at on any authenticated
   * runner call means a runner too old to send a heartbeat still reads as
   * alive — which is the case that made every runner look stale before.
   */
  it('is refreshed by any authenticated runner request that names the runner', async () => {
    const db = fakeDb()
    const app = await buildApp(db)

    await app.inject({
      method: 'GET',
      url: '/v1/runner/routes?runner=cerebro',
      headers: { authorization: `Bearer ${RUNNER_KEY}` },
    })

    // Fire-and-forget, so let the microtask queue drain before asserting.
    await new Promise((resolve) => setTimeout(resolve, 10))
    const touch = db.calls.find((call) =>
      call.sql.includes('UPDATE runners SET last_seen_at = now()')
    )
    // Scoped to the runner that made the call. Updating every row in the org,
    // as this once did, marks a machine that has been off for a week alive the
    // moment any other runner polls.
    expect(touch?.params).toEqual(['org_1', 'cerebro'])
    await app.close()
  })

  it('is not refreshed by a call that does not name its runner', async () => {
    const db = fakeDb()
    const app = await buildApp(db)

    await app.inject({
      method: 'POST',
      url: '/v1/runner/runs',
      headers: { authorization: `Bearer ${RUNNER_KEY}` },
      payload: { run: { id: 'pxr_1', status: 'queued' } },
    })

    await new Promise((resolve) => setTimeout(resolve, 10))
    const touch = db.calls.find((call) =>
      call.sql.includes('UPDATE runners SET last_seen_at = now()')
    )
    expect(touch).toBeUndefined()
    await app.close()
  })

  it('is not refreshed by an unauthenticated request', async () => {
    const db = fakeDb()
    const app = await buildApp(db)
    await app.inject({ method: 'GET', url: '/v1/runner/routes' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(
      db.calls.some((call) => call.sql.includes('UPDATE runners SET last_seen_at = now()'))
    ).toBe(false)
    await app.close()
  })
})
