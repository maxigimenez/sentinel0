import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fillRouteTemplate,
  findRouteTemplate,
  type Logger,
  type ProjectConfig,
} from '@sentinel0/common'
import type { GitHubRestClient } from '@sentinel0/common/github'
import { LinearService } from '../../src/linear/service.js'
import { GitHubService } from '../../src/github/service.js'
import { openDatabase } from '../../src/database.js'
import { HermesClient } from '../../src/hermes/client.js'
import { HermesAdapter } from '../../src/hermes/adapter.js'
import { Dispatcher } from '../../src/routing/dispatcher.js'
import { RunLifecycle } from '../../src/routing/run-lifecycle.js'
import { observeCycle } from '../../src/triggers/history.js'
import { startFakeHermes } from '../hermes/fake-hermes-server.js'

afterEach(() => vi.unstubAllGlobals())

describe('assignment through collection, history, dispatch and reporting', () => {
  it.each(['linear', 'github'] as const)(
    '%s starts once on first observation, uses the right repo and reports to the issue',
    async (provider) => {
      const hermes = await startFakeHermes({
        statuses: ['completed'],
        output: 'SENTINEL0_SUMMARY: PR https://github.com/acme/platform/pull/7; tests passed.',
      })
      const db = openDatabase('memory')
      const logger: Logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        success: vi.fn(),
        event: vi.fn(),
      }
      const postComment = vi.fn(async () => undefined)
      const project: ProjectConfig = {
        id: 'eng',
        provider,
        filters: { team: 'ENG', repository: 'acme/platform', owner: 'acme', repo: 'platform' },
      }
      const originalFetch = globalThis.fetch
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input, init) => {
          if (String(input) !== 'https://linear.test/graphql') {
            return originalFetch(input, init)
          }
          return Response.json({
            data: {
              organization: { id: 'w' },
              issues: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: 'issue-id',
                    identifier: 'ENG-1',
                    title: 'Export',
                    description: 'CSV',
                    assignee: { id: 'u' },
                    state: { name: 'Todo', type: 'unstarted' },
                    updatedAt: 'r',
                  },
                ],
              },
            },
          })
        })
      )
      const source =
        provider === 'linear'
          ? new LinearService(async () => 'key', 'https://linear.test/graphql')
          : new GitHubService({
              issues: async () => [
                {
                  number: 1,
                  title: 'Export',
                  body: 'CSV',
                  assignees: [{ login: 'bot' }],
                  labels: [],
                  state: 'open',
                  updated_at: 'r',
                },
              ],
              pullRequests: async () => [],
            } as unknown as GitHubRestClient)
      const route = {
        ...fillRouteTemplate(findRouteTemplate(`${provider}-assigned-implementation`)!, {
          '<PROJECT_ID>': 'eng',
          '<AGENT_GITHUB_LOGIN>': 'bot',
          '<LINEAR_USER_ID>': 'u',
          '<LINEAR_WORKSPACE_ID>': 'w',
        }),
        id: 'assignment',
      }
      const dispatcher = new Dispatcher({
        db,
        logger,
        lifecycle: new RunLifecycle(db, logger),
        outcomes: { postComment, updateLabels: async () => undefined },
        agents: [
          {
            profile: 'coder',
            enabled: true,
            githubLogin: 'bot',
            linearUserId: 'u',
            linearWorkspaceId: 'w',
            toolsets: [],
            skills: [],
            discoveredAt: 0,
          },
        ],
        adapters: new Map([
          [
            'coder',
            new HermesAdapter(
              new HermesClient({ baseUrl: hermes.baseUrl, profile: 'coder', apiKey: 'k' }),
              logger,
              { pollIntervalMs: 5 }
            ),
          ],
        ]),
        newRunId: () => 'run_assignment',
      })
      try {
        const [event] = observeCycle(db, project.id, await source.collect(project))
        expect(event.changes).toBeUndefined()
        expect(await dispatcher.dispatch(event, [route])).toMatchObject({ status: 'completed' })
        expect(
          await dispatcher.dispatch({ ...event, revision: 'agent-changed-the-item' }, [route])
        ).toMatchObject({ reason: 'duplicate' })
        expect(hermes.createdBodies).toHaveLength(1)
        expect(hermes.createdBodies[0]).toMatchObject({
          input: expect.stringContaining('Repository: acme/platform'),
        })
        expect(postComment).toHaveBeenCalledWith(
          'ticket',
          expect.objectContaining({
            provider,
            ref: provider === 'linear' ? 'ENG-1' : 'acme/platform#1',
          }),
          expect.stringContaining('/pull/7')
        )
      } finally {
        await hermes.close()
        db.close()
      }
    }
  )
})
