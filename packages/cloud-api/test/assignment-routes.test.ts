import { beforeAll, describe, expect, it, vi } from 'vitest'
import { fillRouteTemplate, findRouteTemplate } from '@sentinel0/common'
import { buildApp } from '../src/app.js'
import type { Database } from '../src/db.js'

beforeAll(() => {
  process.env.LOG_LEVEL = 'silent'
})

function database(options: { repository?: string; provider?: string; agents?: number } = {}) {
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM api_keys')) {
      return { rows: [{ id: 'key', org_id: 'org', scope: 'user', revoked_at: null }], rowCount: 1 }
    }
    if (sql.includes('FROM projects')) {
      expect(params).toEqual(['org', 'eng'])
      return {
        rows: [
          { provider: options.provider ?? 'linear', filters: { repository: options.repository } },
        ],
        rowCount: 1,
      }
    }
    if (sql.includes('FROM agents')) {
      expect(params).toEqual(['org', null, null, 'user-id', 'workspace-id'])
      return {
        rows: Array.from({ length: options.agents ?? 1 }, (_, id) => ({ id })),
        rowCount: options.agents ?? 1,
      }
    }
    return { rows: [], rowCount: 1 }
  })
  return { db: { query } as unknown as Database, query }
}

const route = () =>
  fillRouteTemplate(findRouteTemplate('linear-assigned-implementation')!, {
    '<PROJECT_ID>': 'eng',
    '<LINEAR_USER_ID>': 'user-id',
    '<LINEAR_WORKSPACE_ID>': 'workspace-id',
  })

describe('assignment route configuration', () => {
  it.each(['POST', 'PUT'] as const)(
    'accepts a complete %s configuration scoped to its organization',
    async (method) => {
      const { db } = database({ repository: 'acme/platform' })
      const app = await buildApp(db)
      try {
        const response = await app.inject({
          method,
          url: method === 'POST' ? '/v1/routes' : '/v1/routes/rt_1',
          headers: { authorization: 'Bearer snt_usr_test' },
          payload: route(),
        })
        expect(response.statusCode).toBe(method === 'POST' ? 201 : 200)
        expect(response.json().route.target.agentRef).toEqual({
          linearUserId: 'user-id',
          linearWorkspaceId: 'workspace-id',
        })
      } finally {
        await app.close()
      }
    }
  )

  it.each([
    [{}, 'repository'],
    [{ repository: 'acme/platform', agents: 0 }, 'exactly one'],
    [{ repository: 'acme/platform', agents: 2 }, 'exactly one'],
    [{ repository: 'acme/platform', provider: 'github' }, 'same provider'],
  ] as const)('refuses an unusable enabled route: %j', async (options, reason) => {
    const { db, query } = database(options)
    const app = await buildApp(db)
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/routes',
        headers: { authorization: 'Bearer snt_usr_test' },
        payload: route(),
      })
      expect(response.statusCode).toBe(400)
      expect(response.json().error).toContain(reason)
      expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO routes'))).toBe(false)
    } finally {
      await app.close()
    }
  })

  it('allows a disabled draft to be saved before its prerequisites are ready', async () => {
    const { db } = database()
    const app = await buildApp(db)
    try {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/routes',
            headers: { authorization: 'Bearer snt_usr_test' },
            payload: { ...route(), enabled: false },
          })
        ).statusCode
      ).toBe(201)
    } finally {
      await app.close()
    }
  })
})
