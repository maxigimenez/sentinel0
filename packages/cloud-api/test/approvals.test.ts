import { beforeAll, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import { hashKey } from '../src/auth.js'
import type { Database } from '../src/db.js'

beforeAll(() => {
  process.env.LOG_LEVEL = 'silent'
})

interface Recorded {
  sql: string
  params: unknown[]
}

const USER_KEY = 'snt_usr_test'
const USER = { authorization: `Bearer ${USER_KEY}` }

/** As in the other route tests: answered by intent, since Postgres is not here. */
function fakeDb(run?: {
  runner_id: string | null
  status: string
}): Database & { writes: Recorded[] } {
  const writes: Recorded[] = []
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM api_keys')) {
      const scope = params[0] === hashKey(USER_KEY) ? 'user' : 'runner'
      return { rows: [{ id: 'key_1', org_id: 'org_1', scope, revoked_at: null }], rowCount: 1 }
    }
    if (sql.includes('FROM runs WHERE org_id')) {
      return run ? { rows: [run], rowCount: 1 } : { rows: [], rowCount: 0 }
    }
    if (!sql.trimStart().toUpperCase().startsWith('SELECT')) {
      writes.push({ sql, params })
    }
    return { rows: [], rowCount: 0 }
  })

  return { query, writes } as unknown as Database & { writes: Recorded[] }
}

const approve = (payload: unknown) => ({
  method: 'POST' as const,
  url: '/v1/runs/pxr_1/approval',
  headers: USER,
  payload,
})

describe('POST /v1/runs/:id/approval', () => {
  it('queues an approve command addressed at the runner holding the run', async () => {
    const db = fakeDb({ runner_id: 'rnr_1', status: 'awaiting_approval' })
    const app = await buildApp(db)

    const response = await app.inject(approve({ choice: 'session' }))

    expect(response.statusCode).toBe(202)
    const queued = db.writes.find((write) => write.sql.includes('INSERT INTO runner_commands'))!
    expect(queued.sql).toContain("'approve'")
    // Addressed, unlike cancel: an approval that reaches a machine which is not
    // running the run is a command nothing will ever answer, and nothing will
    // retry it.
    expect(queued.params[2]).toBe('rnr_1')
    expect(JSON.parse(String(queued.params[3]))).toEqual({ runId: 'pxr_1', choice: 'session' })
    await app.close()
  })

  it.each(['once', 'session', 'always', 'deny'])('accepts the choice %s', async (choice) => {
    const db = fakeDb({ runner_id: 'rnr_1', status: 'awaiting_approval' })
    const app = await buildApp(db)

    expect((await app.inject(approve({ choice }))).statusCode).toBe(202)
    await app.close()
  })

  /**
   * The vocabulary is Hermes', not ours.
   *
   * `{"decision": "approve"}` -- what the runner's client sent for months --
   * comes back from the real gateway as `invalid_approval_choice`. Rejecting it
   * here means the mistake cannot be made twice.
   */
  it('refuses anything outside Hermes’ vocabulary', async () => {
    const db = fakeDb({ runner_id: 'rnr_1', status: 'awaiting_approval' })
    const app = await buildApp(db)

    for (const payload of [{ decision: 'approve' }, { choice: 'approve' }, {}, { choice: 1 }]) {
      const response = await app.inject(approve(payload))
      expect(response.statusCode).toBe(400)
      expect(response.json().error).toContain('once, session, always, deny')
    }
    expect(db.writes.filter((w) => w.sql.includes('runner_commands'))).toEqual([])
    await app.close()
  })

  it('refuses a run that is not waiting, and says what it is doing instead', async () => {
    const db = fakeDb({ runner_id: 'rnr_1', status: 'completed' })
    const app = await buildApp(db)

    const response = await app.inject(approve({ choice: 'session' }))

    expect(response.statusCode).toBe(409)
    expect(response.json().error).toContain('completed')
    await app.close()
  })

  it('404s a run this org does not have', async () => {
    const app = await buildApp(fakeDb())
    expect((await app.inject(approve({ choice: 'session' }))).statusCode).toBe(404)
    await app.close()
  })
})
