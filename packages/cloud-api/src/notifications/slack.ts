import type { RunRecord } from '@sentinel0/common'
import type { Database } from '../db.js'

export type NotificationEvent =
  | 'run.started'
  | 'run.completed'
  | 'run.failed'
  | 'run.needs_approval'
  | 'run.canceled'
  | 'runner.stale'

const ICONS: Record<NotificationEvent, string> = {
  'run.started': ':hourglass_flowing_sand:',
  'run.completed': ':white_check_mark:',
  'run.failed': ':x:',
  'run.needs_approval': ':raising_hand:',
  'run.canceled': ':black_square_for_stop:',
  'runner.stale': ':warning:',
}

function duration(run: RunRecord): string | undefined {
  if (!run.startedAt || !run.endedAt) {
    return undefined
  }
  const seconds = Math.round((run.endedAt - run.startedAt) / 1000)
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

/**
 * The message a human reads to know what the agents are doing.
 *
 * Leads with the agent and what triggered it, because that is the question
 * someone glancing at the channel is actually asking.
 */
export function buildSlackMessage(
  event: NotificationEvent,
  run: RunRecord,
  agent?: { avatarUrl?: string; displayName?: string }
): Record<string, unknown> {
  const took = duration(run)
  const lines = [
    `${ICONS[event]} *${run.agentProfile}* ${verb(event)} — ${run.title}`,
    [
      run.triggerUrl ? `<${run.triggerUrl}|${run.triggerRef}>` : run.triggerRef,
      run.routeName ? `via _${run.routeName}_` : undefined,
      took ? `in ${took}` : undefined,
    ]
      .filter(Boolean)
      .join('  ·  '),
  ]

  const detail = event === 'run.failed' ? run.error : run.summary
  if (detail) {
    // Slack renders long blocks badly; the run detail page has the full text.
    lines.push('', detail.length > 600 ? `${detail.slice(0, 600)}…` : detail)
  }

  // A run waiting on a person is the one message that must say what to do about
  // it. Without this it announced a decision was needed and named no way to
  // make one, which is how an agent ends up blocked for an afternoon.
  if (event === 'run.needs_approval') {
    const asked = run.approvalDetail?.command ?? run.approvalDetail?.arguments
    const tool = run.approvalDetail?.tool
    if (asked || tool) {
      const wants = asked ? truncate(asked, 200) : tool!
      lines.push('', `Wants to run: \`${wants}\``)
    }
    lines.push('', unblockHint(run))
  }

  const text = lines.join('\n')

  // The agent's avatar goes *inside* the message, as a Block Kit accessory --
  // never as top-level `username`/`icon_url`, which would override the Slack
  // app's own identity on the webhook. `text` is kept alongside `blocks` so
  // notifications and previews still read correctly where blocks are not shown.
  if (!agent?.avatarUrl) {
    return { text, mrkdwn: true }
  }

  return {
    text,
    mrkdwn: true,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text },
        accessory: {
          type: 'image',
          image_url: agent.avatarUrl,
          alt_text: agent.displayName ?? run.agentProfile,
        },
      },
    ],
  }
}

/**
 * Where to go to answer a gate.
 *
 * The dashboard link needs `DASHBOARD_URL`, which nothing in cloud-api had --
 * the browser learns the API's address, never the other way round. Without it
 * configured the CLI fallback still tells an operator exactly what to type,
 * which beats the silence this replaces.
 */
function unblockHint(run: RunRecord): string {
  const base = process.env.DASHBOARD_URL?.replace(/\/+$/, '')
  const cli = `\`sentinel0 approve ${run.id}\` · \`sentinel0 approve ${run.id} --deny\``
  return base
    ? `Approve or deny: <${base}/runs/${run.id}|open in the dashboard> · ${cli}`
    : `Approve or deny: ${cli}`
}

function truncate(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

function verb(event: NotificationEvent): string {
  switch (event) {
    case 'run.started':
      return 'started'
    case 'run.completed':
      return 'finished'
    case 'run.failed':
      return 'failed'
    case 'run.needs_approval':
      return 'needs approval'
    case 'run.canceled':
      return 'was canceled'
    case 'runner.stale':
      return 'went offline'
  }
}

interface SlackConfigRow {
  webhook_url: string
  events: string[]
  enabled: boolean
}

/**
 * Posts one run lifecycle event to the org's Slack webhook.
 *
 * Never throws: notification is a side channel, and a Slack outage must not
 * fail the runner's mirror write. The `(run_id, event)` unique constraint on
 * `notification_deliveries` is what makes this safe to call more than once for
 * the same transition -- a duplicate insert loses the race and does not post.
 */
export async function notifyRunEvent(
  db: Database,
  orgId: string,
  run: RunRecord,
  event: string
): Promise<void> {
  try {
    const { rows } = await db.query<SlackConfigRow>(
      'SELECT webhook_url, events, enabled FROM slack_integrations WHERE org_id = $1',
      [orgId]
    )
    const config = rows[0]
    if (!config?.enabled || !config.events.includes(event)) {
      return
    }

    // Claim the delivery. Re-claiming is allowed only when the previous attempt
    // did not succeed: without that, one transient Slack outage would suppress
    // that notification permanently, because the claim row already existed.
    const claimed = await db.query(
      `INSERT INTO notification_deliveries (org_id, run_id, event, status, attempts)
       VALUES ($1,$2,$3,'pending',1)
       ON CONFLICT (run_id, event) DO UPDATE
         SET attempts = notification_deliveries.attempts + 1
         WHERE notification_deliveries.status <> 'delivered'
           AND notification_deliveries.attempts < 5
       RETURNING id`,
      [orgId, run.id, event]
    )
    if (claimed.rowCount === 0) {
      return
    }

    const agent = await db
      .query<{ avatar_url: string | null; display_name: string | null }>(
        'SELECT avatar_url, display_name FROM agents WHERE org_id = $1 AND profile = $2 LIMIT 1',
        [orgId, run.agentProfile]
      )
      .then((result) => result.rows[0])
      .catch(() => undefined)

    const response = await fetch(config.webhook_url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        buildSlackMessage(event as NotificationEvent, run, {
          avatarUrl: agent?.avatar_url ?? undefined,
          displayName: agent?.display_name ?? undefined,
        })
      ),
      signal: AbortSignal.timeout(10_000),
    })

    await db.query(
      'UPDATE notification_deliveries SET status = $3, last_error = $4 WHERE run_id = $1 AND event = $2',
      [
        run.id,
        event,
        response.ok ? 'delivered' : 'failed',
        response.ok ? null : `HTTP ${response.status}`,
      ]
    )
  } catch (error: unknown) {
    await db
      .query(
        'UPDATE notification_deliveries SET status = $3, last_error = $4 WHERE run_id = $1 AND event = $2',
        [run.id, event, 'failed', error instanceof Error ? error.message : String(error)]
      )
      .catch(() => undefined)
  }
}

/**
 * Tells each org about runners that have stopped checking in.
 *
 * `runner.stale` has been a declared notification, and a default-enabled one,
 * since the first migration -- and nothing ever emitted it. A runner is the
 * only thing that can start an agent, so its going quiet is the single event
 * most worth interrupting someone about, and it was the one event that could
 * not reach anybody.
 *
 * Announced once per outage: `stale_notified_at` is set here and cleared by the
 * next heartbeat, so a machine that is off for a week does not post every pass.
 */
export async function sweepStaleRunners(db: Database): Promise<number> {
  const { rows } = await db.query<{
    org_id: string
    name: string
    last_seen_at: string
    webhook_url: string
    events: string[]
  }>(
    `UPDATE runners r
        SET stale_notified_at = now()
       FROM slack_integrations s
      WHERE s.org_id = r.org_id
        AND s.enabled
        AND s.events @> ARRAY['runner.stale']
        AND r.stale_notified_at IS NULL
        AND r.last_seen_at < now() - interval '90 seconds'
      RETURNING r.org_id, r.name, r.last_seen_at, s.webhook_url, s.events`
  )

  for (const row of rows) {
    const quiet = Math.round((Date.now() - new Date(row.last_seen_at).getTime()) / 60_000)
    const text = [
      `${ICONS['runner.stale']} *${row.name}* ${verb('runner.stale')}`,
      `No heartbeat for ${quiet}m. Nothing will dispatch until it is back.`,
    ].join('\n')

    try {
      await fetch(row.webhook_url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, mrkdwn: true }),
        signal: AbortSignal.timeout(10_000),
      })
    } catch {
      // Best effort, like every other notification here. The flag stays set:
      // re-announcing a known-dead runner on the next pass is worse than
      // missing one message about it.
    }
  }

  return rows.length
}
