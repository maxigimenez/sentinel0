import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProjectConfig } from '@sentinel0/common'
import { LinearService } from '../../src/linear/service.js'

const project: ProjectConfig = {
  id: 'eng',
  provider: 'linear',
  filters: { team: 'ENG', repository: 'acme/platform' },
}
const issue = (id: string, assignee: string | null = 'bot-id') => ({
  id,
  identifier: `ENG-${id}`,
  title: 'Implement export',
  description: 'CSV',
  updatedAt: 'r1',
  state: { name: 'Todo', type: 'unstarted' },
  assignee: assignee ? { id: assignee } : null,
  labels: { nodes: [] },
})
const page = (nodes: unknown[], next: string | null = null) => ({
  data: {
    organization: { id: 'workspace-id' },
    issues: { nodes, pageInfo: { hasNextPage: Boolean(next), endCursor: next } },
  },
})

afterEach(() => vi.unstubAllGlobals())

describe('Linear assignment collection', () => {
  it('collects every page and preserves immutable identity and repository context', async () => {
    const requests: Array<{ query: string; variables: { after?: string; filter: unknown } }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        const body = JSON.parse(init.body)
        requests.push(body)
        return Response.json(
          body.variables.after
            ? page([issue('101', null)])
            : page(
                Array.from({ length: 100 }, (_, n) => issue(String(n))),
                'cursor-1'
              )
        )
      })
    )
    const events = await new LinearService(async () => 'key').collect(project)
    expect(events).toHaveLength(101)
    expect(events[0]).toMatchObject({
      assignees: ['bot-id'],
      linearWorkspaceId: 'workspace-id',
      repository: 'acme/platform',
      isClosed: false,
    })
    expect(events.at(-1)?.assignees).toEqual([])
    expect(requests[0].query).toContain('assignee { id }')
    expect(requests[1].variables).toMatchObject({
      after: 'cursor-1',
      filter: { team: { key: { eq: 'ENG' } } },
    })
  })

  it('marks terminal Linear states regardless of their display names', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          page([
            { ...issue('1'), state: { name: 'Shipped', type: 'completed' } },
            { ...issue('2'), state: { name: 'Wont fix', type: 'canceled' } },
          ])
        )
      )
    )
    expect(
      (await new LinearService(async () => 'key').collect(project)).map((event) => event.isClosed)
    ).toEqual([true, true])
  })

  it('rejects a repeated cursor instead of returning an incomplete collection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(page([issue('1')], 'stuck')))
    )
    await expect(new LinearService(async () => 'key').collect(project)).rejects.toThrow(
      'pagination did not advance'
    )
  })

  it('fails the cycle when a later page fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json(page([issue('1')], 'next')))
        .mockResolvedValueOnce(Response.json({ errors: [{ message: 'rate limited' }] }))
    )
    await expect(new LinearService(async () => 'key').collect(project)).rejects.toThrow(
      'rate limited'
    )
  })

  it('refuses to combine pages from different workspaces after credential rotation', async () => {
    const next = page([issue('2')])
    next.data.organization.id = 'other-workspace'
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json(page([issue('1')], 'next')))
        .mockResolvedValueOnce(Response.json(next))
    )
    await expect(new LinearService(async () => 'key').collect(project)).rejects.toThrow(
      'workspace changed'
    )
  })
})
