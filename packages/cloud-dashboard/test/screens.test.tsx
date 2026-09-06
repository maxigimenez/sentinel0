import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import agentsFixture from './fixtures/agents.json'
import eventsFixture from './fixtures/runs_run_1_events.json'
import keysFixture from './fixtures/keys.json'
import meFixture from './fixtures/me.json'
import projectsFixture from './fixtures/projects.json'
import routesFixture from './fixtures/routes.json'
import runFixture from './fixtures/runs_run_1.json'
import waitingRunFixture from './fixtures/runs_run_2.json'
import runnersFixture from './fixtures/runners.json'
import runsFixture from './fixtures/runs_limit_100.json'
import slackFixture from './fixtures/integrations_slack.json'

/**
 * Renders the real screens against payloads recorded from a running cloud-api
 * over a real Postgres.
 *
 * Hand-written fixtures would have been typed from the source of `user.ts` and
 * would have agreed with it by construction — including on the details that
 * actually break a browser, like `run_events.ts` arriving as a string because
 * node-postgres will not narrow a bigint. These came off the wire.
 */
const ROUTES: Record<string, unknown> = {
  '/v1/me': meFixture,
  '/v1/runners': runnersFixture,
  '/v1/agents': agentsFixture,
  '/v1/projects': projectsFixture,
  '/v1/routes': routesFixture,
  '/v1/runs': runsFixture,
  '/v1/runs/run_1': runFixture,
  '/v1/runs/run_1/events': eventsFixture,
  '/v1/runs/run_2': waitingRunFixture,
  '/v1/runs/run_2/events': eventsFixture,
  '/v1/keys': keysFixture,
  '/v1/integrations/slack': slackFixture,
  '/v1/route-templates': { templates: [] },
  '/v1/prompt-templates': { templates: [], variables: ['ticket.ref', 'ticket.url'] },
}

beforeEach(() => {
  vi.resetModules()
  ;(window as unknown as { __SENTINEL0__?: unknown }).__SENTINEL0__ = { apiUrl: 'https://api.test' }
  window.localStorage.setItem('sentinel0.userKey', 'snt_usr_test')

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname
      const body = ROUTES[path]
      if (!body) {
        return new Response(JSON.stringify({ error: `no fixture for ${path}` }), { status: 404 })
      }
      return new Response(JSON.stringify(body), { status: 200 })
    })
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

async function renderAt(path: string) {
  window.history.pushState({}, '', path)
  const { App } = await import('../src/App.js')
  return render(<App />)
}

describe('signed-in shell', () => {
  it('restores the stored key and shows the organization', async () => {
    await renderAt('/')
    expect(await screen.findByText('Sentinel0 Labs')).toBeTruthy()
    // The nav is present, so the shell rendered rather than the login form.
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeTruthy()
  })

  const withRunner = (patch: Record<string, unknown>) => {
    const runners = { runners: [{ ...runnersFixture.runners[0], ...patch }] }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const path = new URL(String(input)).pathname
        const body = path === '/v1/runners' ? runners : ROUTES[path]
        return new Response(JSON.stringify(body ?? {}), { status: body ? 200 : 404 })
      })
    )
  }

  it('reports a runner that is checking in as live', async () => {
    withRunner({ stale: false, hermes_ok: true, active_runs: 0 })
    await renderAt('/')
    expect(await screen.findByText(/cerebro · live/)).toBeTruthy()
  })

  it('reports how many runs are in flight when there are any', async () => {
    withRunner({ stale: false, hermes_ok: true, active_runs: 3 })
    await renderAt('/')
    expect(await screen.findByText(/cerebro · 3 running/)).toBeTruthy()
  })

  it('names when a stale runner was last seen', async () => {
    withRunner({ stale: true })
    await renderAt('/')
    expect(await screen.findByText(/cerebro · last seen/)).toBeTruthy()
  })

  /**
   * Three states, not two. A runner that is checking in but cannot reach Hermes
   * will never start anything, and calling that healthy would defeat the point
   * of the indicator.
   */
  it('distinguishes a live runner that cannot reach Hermes', async () => {
    withRunner({ stale: false, hermes_ok: false, hermes_detail: 'ECONNREFUSED' })
    await renderAt('/')
    expect(await screen.findByText(/cerebro · hermes unreachable/)).toBeTruthy()
  })
})

describe('overview', () => {
  it('counts each status from the real run payload', async () => {
    await renderAt('/')
    // Scoped to the tiles: "running" and "failed" also appear as row badges.
    await screen.findByText('Flaky auth test on CI')
    const tiles = [...document.querySelectorAll('.px-stat')] as HTMLElement[]
    const tileFor = (label: string): HTMLElement =>
      tiles.find((tile) => within(tile).queryByText(label))!

    expect(within(tileFor('running')).getByText('2')).toBeTruthy()
    expect(within(tileFor('queued')).getByText('1')).toBeTruthy()
    expect(within(tileFor('failed')).getByText('1')).toBeTruthy()
    expect(within(tileFor('completed')).getByText('1')).toBeTruthy()
  })

  it('lists only the unfinished runs as active work', async () => {
    await renderAt('/')
    expect(await screen.findByText('Flaky auth test on CI')).toBeTruthy()
    expect(screen.getByText('Rate-limit the webhook fan-out')).toBeTruthy()
    expect(screen.getByText('Bump pg driver to 3.4')).toBeTruthy()
    // Completed and failed runs belong on the runs screen, not here.
    expect(screen.queryByText('Split ingest worker per tenant')).toBeNull()
  })

  it('warns that a failed run holds its label', async () => {
    await renderAt('/')
    expect(await screen.findByText(/sentinel0:failed/)).toBeTruthy()
  })
})

describe('run detail', () => {
  it('renders event times from a bigint timestamp rather than a dash', async () => {
    await renderAt('/runs/run_1')
    expect(await screen.findByText('Run created')).toBeTruthy()

    const times = document.querySelectorAll('.px-event__time')
    expect(times.length).toBeGreaterThan(0)
    for (const node of times) {
      expect(node.textContent).not.toBe('—')
    }
  })

  it('offers cancellation only while the run is unfinished', async () => {
    await renderAt('/runs/run_1')
    expect(await screen.findByRole('button', { name: /cancel run/i })).toBeTruthy()
  })

  it('shows the hermes ids and the commands to tap into a run', async () => {
    await renderAt('/runs/run_2')
    expect(await screen.findByText('run_6a3a5d57840f44958c4331581a7768db')).toBeTruthy()
    expect(screen.getByText('ses_9f2c')).toBeTruthy()
    expect(screen.getByText(/sentinel0 logs --run run_2 --follow/)).toBeTruthy()
  })

  /**
   * The whole point of the iteration: an agent that stops for permission has to
   * be answerable from the one screen that works when you are not on the
   * runner's network.
   */
  it('lets a waiting run be approved, and says what it is waiting for', async () => {
    await renderAt('/runs/run_2')

    expect(await screen.findByText('gh pr review 42 --approve')).toBeTruthy()
    const approve = screen.getByRole('button', { name: /^approve$/i })

    await userEvent.click(approve)

    await waitFor(() => {
      const posted = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
        .map((call) => call[1] as RequestInit | undefined)
        .filter((init) => init?.method === 'POST')
      expect(posted).toHaveLength(1)
      // `session` rather than `once`: an agent stopped mid-task will ask again
      // moments later, and clicking approve repeatedly is not consent.
      expect(JSON.parse(String(posted[0]!.body))).toEqual({ choice: 'session' })
    })
  })

  it('asks before denying, because a denial usually ends the run', async () => {
    await renderAt('/runs/run_2')

    await userEvent.click(await screen.findByRole('button', { name: /^deny$/i }))

    expect(await screen.findByText(/Deny this request/i)).toBeTruthy()
  })
})

describe('other screens', () => {
  it('lists agents with their models', async () => {
    await renderAt('/agents')
    // The display name also reaches the avatar's accessible name, so more than
    // one node legitimately carries it.
    expect((await screen.findAllByText('Product')).length).toBeGreaterThan(0)
    expect(screen.getAllByText('hermes-4-70b').length).toBe(2)
    expect(screen.getByText('hermes-4-405b')).toBeTruthy()
    // An agent with no display name falls back to its profile rather than blank.
    expect(screen.getAllByText('coder').length).toBeGreaterThan(0)
  })

  it('lists the stored route and offers to edit it', async () => {
    await renderAt('/routes')
    expect(await screen.findByText('Assess on label edited')).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Edit route/ })).toBeTruthy()
    // Creating lives on its own page, so the list carries a link to it rather
    // than a form.
    expect(screen.getByRole('button', { name: /^new route$/i })).toBeTruthy()
  })

  it('lists the registered project', async () => {
    await renderAt('/projects')
    expect(await screen.findByText('acme/platform')).toBeTruthy()
  })

  it('marks the key in use and does not offer to revoke it', async () => {
    await renderAt('/keys')
    expect(await screen.findByText('this session')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /revoke key bootstrap user key/i })).toBeNull()
  })

  it('reports Slack as not connected', async () => {
    await renderAt('/settings')
    expect(await screen.findByText('not connected')).toBeTruthy()
  })
})

describe('signed out', () => {
  it('shows the login form when no key is stored', async () => {
    window.localStorage.clear()
    await renderAt('/')
    expect(await screen.findByRole('button', { name: /unlock workspace/i })).toBeTruthy()
  })

  it('drops a stored key the API rejects, rather than looping on 401s', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'nope' }), { status: 401 }))
    )
    await renderAt('/')
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /unlock workspace/i })).toBeTruthy()
    )
    expect(window.localStorage.getItem('sentinel0.userKey')).toBeNull()
  })
})

describe('layout chain', () => {
  /**
   * ThemeProvider renders a real div between #root and the app. If our class
   * does not reach it, every percentage height below it resolves against an
   * auto-height box and the login card sits at the top of the window rather
   * than centred. This pins the class actually landing on that element.
   */
  it('puts px-root on the theme wrapper, so heights resolve', async () => {
    window.localStorage.clear()
    const { container } = await renderAt('/')
    const root = container.querySelector('.px-root')
    expect(root).not.toBeNull()

    const login = container.querySelector('.px-login')
    expect(login).not.toBeNull()
    // Direct child, so `.px-root > *` stretches it to the viewport.
    expect(login!.parentElement).toBe(root)
  })

  it('makes the shell a direct child of the same wrapper when signed in', async () => {
    const { container } = await renderAt('/')
    await screen.findByRole('navigation', { name: 'Primary' })
    const shell = container.querySelector('.px-shell')
    expect(shell!.parentElement).toBe(container.querySelector('.px-root'))
  })
})

describe('page header', () => {
  /**
   * Every list screen carries a create button and every detail screen does not,
   * so the actions slot must exist either way. Rendering it conditionally makes
   * the header — and the panel under it — shift by a button's height as you
   * move between sections.
   */
  it('renders the actions slot on every screen, with or without a button', async () => {
    for (const [path, expectAction] of [
      ['/', true],
      ['/runs', true],
      ['/routes', true],
      ['/projects', true],
      ['/keys', true],
      ['/agents', false],
      ['/settings', false],
    ] as const) {
      const { container, unmount } = await renderAt(path)
      await screen.findByRole('navigation', { name: 'Primary' })

      const slot = container.querySelector('.px-topbar__actions')
      expect(slot, `${path} must render an actions slot`).not.toBeNull()
      expect(slot!.childElementCount > 0, `${path} action button presence`).toBe(expectAction)
      unmount()
    }
  })
})

/**
 * Starting an agent on a prompt written here, with no route behind it.
 *
 * The interesting part is not the form — it is that the choices offered can
 * only produce a command a runner can answer: an agent that lives on the
 * selected machine, and is enabled.
 */
describe('running an agent from the runs screen', () => {
  const openDialog = async () => {
    await renderAt('/runs')
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /run agent/i }))
    return user
  }

  it('offers the runs screen a way to start a run', async () => {
    await renderAt('/runs')
    expect(await screen.findByRole('button', { name: /run agent/i })).toBeTruthy()
  })

  it('opens a dialog naming the runner and the agent', async () => {
    await openDialog()
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('heading', { name: /run an agent/i })).toBeTruthy()
    expect(within(dialog).getByLabelText(/runner/i)).toBeTruthy()
    expect(within(dialog).getByLabelText(/agent/i)).toBeTruthy()
    expect(within(dialog).getByLabelText(/prompt/i)).toBeTruthy()
  })

  /**
   * A disabled profile would be accepted by the form and refused by the API,
   * one round trip later. Offering only what can actually run is the difference
   * between a dropdown and a guess.
   */
  it('offers only the enabled agents on the selected runner', async () => {
    const user = await openDialog()
    const dialog = await screen.findByRole('dialog')

    // The library's Select is a listbox, not a native <select>: the options
    // exist only once it is open.
    await user.click(within(dialog).getByLabelText(/agent/i))
    const offered = (await screen.findAllByRole('option')).map((option) => option.textContent)

    expect(offered.some((label) => label?.includes('product'))).toBe(true)
    expect(offered.some((label) => label?.includes('reviewer'))).toBe(true)
    // `coder` is registered on the same runner but disabled.
    expect(offered.some((label) => label?.includes('coder'))).toBe(false)
  })

  it('says when the chosen runner has stopped checking in', async () => {
    await openDialog()
    // The fixture runner is stale. Hiding it would present "no runners" for
    // what is really "the runner stopped polling" — different problems. It is
    // said twice on purpose: once in the option, once as a warning about the
    // consequence, which is that the run waits rather than starting.
    expect(await screen.findByText('That runner is not checking in')).toBeTruthy()
    expect(screen.getByText(/queued and delivered whenever it polls again/i)).toBeTruthy()
  })

  it('will not queue an empty prompt', async () => {
    await openDialog()
    const dialog = await screen.findByRole('dialog')
    const start = within(dialog).getByRole('button', { name: /start run/i })
    expect((start as HTMLButtonElement).disabled).toBe(true)
  })

  it('posts the runner, the agent and the prompt, and reports it queued', async () => {
    const posts: Array<{ url: string; body: unknown }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const path = new URL(String(input)).pathname
        if (init?.method === 'POST' && path === '/v1/runs') {
          posts.push({ url: path, body: JSON.parse(String(init.body)) })
          return new Response(JSON.stringify({ queued: 'cmd_1', runner: 'cerebro' }), {
            status: 202,
          })
        }
        const body = ROUTES[path]
        return new Response(JSON.stringify(body ?? {}), { status: body ? 200 : 404 })
      })
    )

    const user = await openDialog()
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText(/prompt/i), 'Audit the billing export')
    await user.click(within(dialog).getByRole('button', { name: /start run/i }))

    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].body).toMatchObject({
      runnerId: 'rnr_examplexxxxxxxx1',
      agentProfile: 'product',
      prompt: 'Audit the billing export',
    })

    // The run does not exist until the runner polls, so the confirmation has to
    // say so rather than leaving someone watching an unchanged list.
    expect(await screen.findByText(/next poll/i)).toBeTruthy()
  })
})
