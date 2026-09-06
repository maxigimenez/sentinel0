import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * A stand-in for a Hermes profile's API server.
 *
 * Exists so the adapter's stream-plus-poll reconciliation, timeout, cancel, and
 * degradation paths are testable without the Mac Mini. Deliberately supports
 * misbehaving: `eventsStatus` and `failPollsBefore` let a test assert that a
 * broken event stream or a flaky poll does not sink an otherwise fine run.
 */
export interface FakeHermesOptions {
  /** Statuses returned by successive `GET /v1/runs/:id` calls; the last repeats. */
  statuses?: string[]
  output?: unknown
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number }
  sessionId?: string
  runError?: string
  /** SSE frames emitted on `GET /v1/runs/:id/events`, in order. */
  events?: Array<{ event: string; data: unknown }>
  /** Non-200 to simulate an unavailable event stream. */
  eventsStatus?: number
  /** Fail this many polls before answering, to simulate a flaky gateway. */
  failPollsBefore?: number
  /** Reject `POST /v1/runs` with this status. */
  createStatus?: number
  requireBearer?: string
  /** Multiplex prefix the server insists on, e.g. `/p/product`. */
  expectPrefix?: string
}

/** Hermes' approval vocabulary, spelled out so the fake cannot drift from it. */
const APPROVAL_CHOICES = ['once', 'session', 'always', 'deny']

export interface FakeHermes {
  baseUrl: string
  close(): Promise<void>
  /** Every path the server was asked for, in order. */
  requests: string[]
  stopCalls: string[]
  approvalCalls: Array<{ runId: string; body: unknown }>
  createdBodies: unknown[]
  pollCount: number
}

export async function startFakeHermes(options: FakeHermesOptions = {}): Promise<FakeHermes> {
  const statuses = options.statuses ?? ['completed']
  const events = options.events ?? []
  const requests: string[] = []
  const stopCalls: string[] = []
  const approvalCalls: Array<{ runId: string; body: unknown }> = []
  const createdBodies: unknown[] = []
  let pollCount = 0

  const server: Server = createServer((req, res) => {
    const url = req.url ?? ''
    requests.push(`${req.method} ${url}`)

    if (options.requireBearer && req.headers.authorization !== `Bearer ${options.requireBearer}`) {
      res.writeHead(401).end('unauthorized')
      return
    }

    // With `expectPrefix` set, only that profile's prefix is served — used to
    // prove the client addresses the right one. Otherwise any `/p/<profile>`
    // prefix is accepted, mirroring a gateway with multiplex_profiles on.
    const path = options.expectPrefix
      ? url.startsWith(options.expectPrefix)
        ? url.slice(options.expectPrefix.length)
        : null
      : url.replace(/^\/p\/[^/]+/, '')

    if (path === null) {
      res.writeHead(404).end('wrong profile prefix')
      return
    }

    const readBody = async (): Promise<unknown> => {
      const chunks: Buffer[] = []
      for await (const chunk of req) {
        chunks.push(chunk as Buffer)
      }
      const raw = Buffer.concat(chunks).toString('utf8')
      try {
        return raw ? JSON.parse(raw) : {}
      } catch {
        return raw
      }
    }

    const json = (status: number, payload: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    }

    if (req.method === 'POST' && path === '/v1/runs') {
      void readBody().then((body) => {
        createdBodies.push(body)
        if (options.createStatus) {
          res.writeHead(options.createStatus).end('rejected')
          return
        }
        json(200, { run_id: 'run_test_1', status: 'started' })
      })
      return
    }

    const stopMatch = path.match(/^\/v1\/runs\/([^/]+)\/stop$/)
    if (req.method === 'POST' && stopMatch) {
      stopCalls.push(decodeURIComponent(stopMatch[1]))
      json(200, { status: 'stopping' })
      return
    }

    const approvalMatch = path.match(/^\/v1\/runs\/([^/]+)\/approval$/)
    if (req.method === 'POST' && approvalMatch) {
      void readBody().then((body) => {
        approvalCalls.push({ runId: decodeURIComponent(approvalMatch[1]), body })

        // Validated exactly as the real gateway does. Recording the body
        // without checking it is how a client that sent `{"decision":
        // "approve"}` -- a key and a vocabulary Hermes has never accepted --
        // passed every test in this suite while failing against the real thing.
        const choice = (body as { choice?: unknown } | undefined)?.choice
        if (typeof choice !== 'string' || !APPROVAL_CHOICES.includes(choice)) {
          json(400, {
            error: {
              message: `Invalid approval choice; expected one of: ${APPROVAL_CHOICES.join(', ')}`,
              type: 'invalid_request_error',
              code: 'invalid_approval_choice',
            },
          })
          return
        }
        json(200, { ok: true })
      })
      return
    }

    const eventsMatch = path.match(/^\/v1\/runs\/([^/]+)\/events$/)
    if (req.method === 'GET' && eventsMatch) {
      if (options.eventsStatus) {
        res.writeHead(options.eventsStatus).end('no stream')
        return
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      for (const frame of events) {
        res.write(`event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`)
      }
      // Left open: mirrors the real server, where the stream outliving or
      // predeceasing the run must not decide the run's fate either way.
      req.on('close', () => res.end())
      return
    }

    const runMatch = path.match(/^\/v1\/runs\/([^/]+)$/)
    if (req.method === 'GET' && runMatch) {
      if (options.failPollsBefore && pollCount < options.failPollsBefore) {
        pollCount += 1
        res.writeHead(503).end('gateway busy')
        return
      }
      const index = Math.min(pollCount, statuses.length - 1)
      const status = statuses[index]
      pollCount += 1
      json(200, {
        run_id: decodeURIComponent(runMatch[1]),
        status,
        output: options.output ?? 'done',
        ...(options.usage ? { usage: options.usage } : {}),
        ...(options.sessionId ? { session_id: options.sessionId } : {}),
        ...(options.runError ? { error: options.runError } : {}),
      })
      return
    }

    if (req.method === 'GET' && path === '/v1/capabilities') {
      json(200, { platform: 'hermes-agent', features: { run_submission: true } })
      return
    }
    if (req.method === 'GET' && path === '/v1/models') {
      json(200, { data: [{ id: 'hermes-agent' }] })
      return
    }
    if (req.method === 'GET' && path === '/v1/skills') {
      json(200, [{ name: 'github-pr-workflow' }])
      return
    }
    if (req.method === 'GET' && path === '/v1/toolsets') {
      json(200, [{ name: 'core', enabled: true, tools: ['terminal'] }])
      return
    }

    res.writeHead(404).end('not found')
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    stopCalls,
    approvalCalls,
    createdBodies,
    get pollCount() {
      return pollCount
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
