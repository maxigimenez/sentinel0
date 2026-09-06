import { describe, expect, it } from 'vitest'
import { RUN_STATUS, TRIGGER_TYPE, type RunRecord } from '@sentinel0/common'
import { buildSlackMessage } from '../src/notifications/slack.js'

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'pxr_1',
    routeId: 'rt_1',
    routeName: 'Product review',
    agentProfile: 'product',
    projectId: 'taplands',
    triggerType: TRIGGER_TYPE.TICKET,
    triggerRef: 'LIN-123',
    triggerRevision: 'r',
    triggerUrl: 'https://linear.app/x/LIN-123',
    title: 'Billing export',
    status: RUN_STATUS.COMPLETED,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

describe('buildSlackMessage', () => {
  it('leads with the agent and what it did', () => {
    const message = buildSlackMessage('run.completed', run()) as { text: string }
    expect(message.text).toContain('*product*')
    expect(message.text).toContain('finished')
    expect(message.text).toContain('Billing export')
  })

  it('links the trigger when there is a url, and falls back to the ref', () => {
    expect((buildSlackMessage('run.started', run()) as { text: string }).text).toContain(
      '<https://linear.app/x/LIN-123|LIN-123>'
    )
    const noUrl = buildSlackMessage('run.started', run({ triggerUrl: undefined })) as {
      text: string
    }
    expect(noUrl.text).toContain('LIN-123')
    expect(noUrl.text).not.toContain('<https')
  })

  it('reports duration only when the run actually ran', () => {
    const timed = run({ startedAt: 1_000, endedAt: 96_000 })
    expect((buildSlackMessage('run.completed', timed) as { text: string }).text).toContain(
      'in 1m 35s'
    )
    expect((buildSlackMessage('run.started', run()) as { text: string }).text).not.toContain('in ')
  })

  it('shows the error on failure and the summary on success', () => {
    const failed = run({ status: RUN_STATUS.FAILED, error: 'tool crashed', summary: 'ignored' })
    expect((buildSlackMessage('run.failed', failed) as { text: string }).text).toContain(
      'tool crashed'
    )

    const ok = run({ summary: 'Worth doing.' })
    expect((buildSlackMessage('run.completed', ok) as { text: string }).text).toContain(
      'Worth doing.'
    )
  })

  it('truncates a long detail rather than flooding the channel', () => {
    const long = run({ summary: 'x'.repeat(2000) })
    const text = (buildSlackMessage('run.completed', long) as { text: string }).text
    expect(text.length).toBeLessThan(900)
    expect(text).toContain('…')
  })

  it('has a distinct opener for every event it handles', () => {
    const events = [
      'run.started',
      'run.completed',
      'run.failed',
      'run.needs_approval',
      'run.canceled',
      'runner.stale',
    ] as const
    const openers = events.map(
      (event) => (buildSlackMessage(event, run()) as { text: string }).text.split('\n')[0]
    )
    expect(new Set(openers).size).toBe(events.length)
  })
})

describe('agent avatar', () => {
  it('omits blocks entirely when the agent has no avatar', () => {
    const message = buildSlackMessage('run.completed', run(), {})
    expect(message.blocks).toBeUndefined()
    expect(message.text).toContain('*product*')
  })

  it('renders the avatar inside the message, as an accessory', () => {
    const message = buildSlackMessage('run.completed', run(), {
      avatarUrl: 'https://cdn/product.png',
      displayName: 'Product agent',
    }) as { blocks: Array<Record<string, any>> }

    const accessory = message.blocks[0].accessory
    expect(accessory).toMatchObject({
      type: 'image',
      image_url: 'https://cdn/product.png',
      alt_text: 'Product agent',
    })
  })

  it('never overrides the webhook app identity', () => {
    const message = buildSlackMessage('run.completed', run(), {
      avatarUrl: 'https://cdn/product.png',
      displayName: 'Product agent',
    })

    // The Slack app owns how it appears; the avatar belongs in the body.
    expect(message.username).toBeUndefined()
    expect(message.icon_url).toBeUndefined()
  })

  it('keeps text alongside blocks, for notifications and previews', () => {
    const message = buildSlackMessage('run.failed', run({ error: 'boom' }), {
      avatarUrl: 'https://cdn/x.png',
    }) as { text: string; blocks: Array<Record<string, any>> }

    expect(message.text).toContain('boom')
    expect(message.blocks[0].text.text).toBe(message.text)
  })
})

/**
 * The one message that has to be actionable.
 *
 * A needs-approval notice announced that a decision was required and named no
 * way to make one — there was no approve action anywhere in the product — so
 * the only way out was to cancel the run.
 */
describe('the needs-approval message', () => {
  const waiting = (approvalDetail?: RunRecord['approvalDetail']): string =>
    (
      buildSlackMessage(
        'run.needs_approval',
        run({ status: RUN_STATUS.AWAITING_APPROVAL, approvalDetail })
      ) as { text: string }
    ).text

  it('says what the agent wants to do', () => {
    const text = waiting({ tool: 'bash', command: 'gh pr review 42 --approve', requestedAt: 1 })
    expect(text).toContain('gh pr review 42 --approve')
  })

  it('names the tool when that is all Hermes gave', () => {
    expect(waiting({ tool: 'bash', requestedAt: 1 })).toContain('bash')
  })

  it('always says how to unblock it, even with no detail at all', () => {
    const text = waiting()
    expect(text).toContain('sentinel0 approve pxr_1')
    expect(text).toContain('--deny')
  })

  it('links the run when a dashboard url is configured', () => {
    process.env.DASHBOARD_URL = 'https://sentinel0.example/'
    try {
      // The trailing slash is deliberate: an operator setting this variable
      // will paste whatever the browser showed them.
      expect(waiting()).toContain('<https://sentinel0.example/runs/pxr_1|open in the dashboard>')
    } finally {
      delete process.env.DASHBOARD_URL
    }
  })

  it('stays inside the size other messages are held to', () => {
    const text = waiting({ command: 'x'.repeat(5_000), requestedAt: 1 })
    expect(text.length).toBeLessThan(900)
  })
})
