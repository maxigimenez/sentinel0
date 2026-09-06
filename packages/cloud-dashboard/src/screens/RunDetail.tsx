import { useEffect, useState, type ReactNode } from 'react'
import { useParams } from 'react-router-dom'
import { Badge } from '@16-bits-design/ui/badge'
import { Button } from '@16-bits-design/ui/button'
import { Dialog } from '@16-bits-design/ui/dialog'
import { Text } from '@16-bits-design/ui/typography'
import { useToast } from '@16-bits-design/ui/toast'
import { api } from '../api/endpoints.js'
import { useKey } from '../lib/session.js'
import { useResource } from '../lib/useResource.js'
import { duration, epochMillis, isTerminal, relativeTime, STATUS_TONE } from '../lib/format.js'
import { Alert } from '@16-bits-design/ui/alert'
import { Code } from '@16-bits-design/ui/code'
import { EmptyState } from '@16-bits-design/ui/empty-state'
import { ErrorPanel } from '../components/ErrorPanel.js'
import { Spinner } from '@16-bits-design/ui/spinner'
import { PageHeader } from '../components/PageHeader.js'
import { Panel, Section } from '../components/Panel.js'
import type { Run, RunEvent } from '../api/types.js'

function dotClass(level: string | null): string {
  if (level === 'error') {
    return ' px-event__dot--error'
  }
  if (level === 'warn' || level === 'warning') {
    return ' px-event__dot--warn'
  }
  if (level === 'success') {
    return ' px-event__dot--success'
  }
  return ''
}

function eventTime(event: RunEvent): string {
  const millis = epochMillis(event.ts)
  return millis === undefined ? '—' : new Date(millis).toLocaleTimeString()
}

function formatUsage(usage: Run['usage']): string {
  if (!usage) {
    return '—'
  }
  const tokens = usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
  const cost = usage.costUsd ? ` · $${usage.costUsd.toFixed(2)}` : ''
  return tokens ? `${tokens.toLocaleString()} tokens${cost}` : '—'
}

/**
 * What to type on the runner's own machine to follow or steer this run.
 *
 * Shown rather than described because the ids involved -- the Sentinel0 run,
 * the Hermes run, the profile prefix -- are exactly the things nobody can
 * reconstruct from memory at the moment they need them.
 */
function tapInCommands(run: Run): string[] {
  const lines = [`sentinel0 logs --run ${run.id} --follow`]
  if (run.status === 'awaiting_approval') {
    lines.push(`sentinel0 approve ${run.id}`, `sentinel0 approve ${run.id} --deny`)
  } else if (!isTerminal(run.status)) {
    lines.push(`sentinel0 cancel ${run.id}`)
  }
  if (run.hermes_run_id) {
    const prefix =
      run.agent_profile && run.agent_profile !== 'default' ? `/p/${run.agent_profile}` : ''
    lines.push(
      '',
      "# on the Hermes side (needs that profile's key)",
      `curl "$HERMES_BASE_URL${prefix}/v1/runs/${run.hermes_run_id}" -H "authorization: Bearer $HERMES_KEY"`
    )
  }
  return lines
}

export function RunDetail(): ReactNode {
  const { id = '' } = useParams()
  const key = useKey()
  const { toast } = useToast()
  const [confirming, setConfirming] = useState(false)

  // A live run is watched, not glanced at: three seconds is the difference
  // between seeing an agent work and refreshing to find out whether it did.
  const run = useResource((k, signal) => api.run(k, id, signal), [id], { pollMs: 3_000 })
  const events = useResource((k, signal) => api.runEvents(k, id, signal), [id], { pollMs: 3_000 })

  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  const [denying, setDenying] = useState(false)
  const [answering, setAnswering] = useState(false)

  /**
   * Answers a gate.
   *
   * "Approve" sends Hermes `session`, which unblocks the rest of this run
   * rather than the single call: an agent stopped mid-task will otherwise ask
   * again moments later, and clicking approve four times is not consent, it is
   * an obstacle course.
   */
  const answer = async (choice: 'session' | 'deny'): Promise<void> => {
    setAnswering(true)
    try {
      await api.approveRun(key, id, choice)
      toast({
        tone: choice === 'deny' ? 'warning' : 'info',
        title: choice === 'deny' ? 'Denial queued' : 'Approval queued',
        // Same honesty as cancel: the runner has to collect this before
        // anything actually changes.
        message: 'The runner will pass this to the agent on its next poll.',
      })
      setDenying(false)
      run.reload()
    } catch (error) {
      toast({
        tone: 'danger',
        title: 'Could not answer',
        message: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setAnswering(false)
    }
  }

  const cancel = async (): Promise<void> => {
    try {
      await api.cancelRun(key, id)
      toast({
        tone: 'info',
        title: 'Cancellation queued',
        // Deliberately not "cancelled": the runner has to collect the command
        // and stop the Hermes run, and reporting it as already done would be
        // wrong for the ~25 seconds that takes.
        message: 'The runner will stop this run on its next poll.',
      })
      run.reload()
    } catch (error) {
      toast({
        tone: 'danger',
        title: 'Could not cancel',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  if (run.loading) {
    return (
      <>
        <PageHeader title="Run" parent={{ label: 'Runs', to: '/runs' }} />
        <Panel caption="Loading this run">
          <Spinner label="Loading run" />
        </Panel>
      </>
    )
  }

  if (run.error || !run.data) {
    return (
      <>
        <PageHeader title="Run" parent={{ label: 'Runs', to: '/runs' }} />
        <Panel caption="This run could not be loaded">
          <ErrorPanel message={run.error ?? `Run "${id}" was not found.`} onRetry={run.reload} />
        </Panel>
      </>
    )
  }

  const data = run.data
  const running = !isTerminal(data.status)
  const awaiting = data.status === 'awaiting_approval'
  const wants =
    data.approval_detail?.command ?? data.approval_detail?.arguments ?? data.approval_detail?.tool

  return (
    <>
      <PageHeader
        title={data.title ?? data.trigger_ref ?? data.id}
        parent={{ label: 'Runs', to: '/runs' }}
        actions={
          running ? (
            <Button variant="danger" onClick={() => setConfirming(true)}>
              cancel run
            </Button>
          ) : null
        }
      />

      <Panel
        caption={
          <>
            <Badge tone={STATUS_TONE[data.status] ?? 'neutral'}>
              {data.status.replace(/_/g, ' ')}
            </Badge>
            <Text size="small" tone="muted" as="span">
              {duration(data.started_at, data.ended_at, now)} · updated{' '}
              {relativeTime(data.updated_at, now)}
            </Text>
          </>
        }
      >
        <div className="px-panel__body">
          {data.error ? (
            <Alert tone="danger" title="This run failed">
              {data.error}
            </Alert>
          ) : null}

          {awaiting ? (
            <Alert tone="warning" title="This agent is waiting for you">
              <div className="px-approval">
                {wants ? (
                  <Code label="Waiting to run">{wants}</Code>
                ) : (
                  <Text size="small" tone="soft">
                    Hermes did not say what it wants to do. The run log below is the best account of
                    where it stopped.
                  </Text>
                )}
                <div className="px-approval__actions">
                  <Button onClick={() => void answer('session')} disabled={answering}>
                    approve
                  </Button>
                  <Button variant="danger" onClick={() => setDenying(true)} disabled={answering}>
                    deny
                  </Button>
                </div>
              </div>
            </Alert>
          ) : null}

          <Section title="Details">
            <dl className="px-kv">
              <dt>Run</dt>
              <dd>
                <code>{data.id}</code>
              </dd>
              <dt>Route</dt>
              <dd>{data.route_name ?? '—'}</dd>
              <dt>Agent</dt>
              <dd>{data.agent_profile ?? '—'}</dd>
              <dt>Project</dt>
              <dd>{data.project_id ?? '—'}</dd>
              <dt>Trigger</dt>
              <dd>
                {data.trigger_url ? (
                  <a href={data.trigger_url} target="_blank" rel="noreferrer noopener">
                    {data.trigger_ref ?? data.trigger_url}
                  </a>
                ) : (
                  (data.trigger_ref ?? '—')
                )}
              </dd>
              <dt>Started</dt>
              <dd>{data.started_at ? new Date(data.started_at).toLocaleString() : 'not yet'}</dd>
              <dt>Ended</dt>
              <dd>{data.ended_at ? new Date(data.ended_at).toLocaleString() : '—'}</dd>
              <dt>Hermes run</dt>
              <dd>{data.hermes_run_id ? <code>{data.hermes_run_id}</code> : '—'}</dd>
              <dt>Hermes session</dt>
              <dd>{data.hermes_session_id ? <code>{data.hermes_session_id}</code> : '—'}</dd>
              <dt>Usage</dt>
              <dd>{formatUsage(data.usage)}</dd>
            </dl>
          </Section>

          {/*
            The commands to look at this run from a terminal. The dashboard is
            the view from off the runner's network; when someone is actually on
            that machine, these are faster than anything here.
          */}
          <Section title="Tap in">
            <Code label="Commands">{tapInCommands(data).join('\n')}</Code>
          </Section>

          {data.summary ? (
            <Section title="Summary">
              <Code label="Run summary">{data.summary}</Code>
            </Section>
          ) : null}

          <Section title="Events" padded={false}>
            {events.loading ? (
              <Spinner label="Loading events" />
            ) : events.error ? (
              <ErrorPanel message={events.error} onRetry={events.reload} />
            ) : (events.data ?? []).length === 0 ? (
              <EmptyState title="No events recorded">
                {running
                  ? 'The runner mirrors events as the run progresses. They should appear shortly.'
                  : 'This run finished without reporting any events.'}
              </EmptyState>
            ) : (
              <div className="px-events">
                {(events.data ?? []).map((event, index) => (
                  <div className="px-event" key={`${event.ts}-${index}`}>
                    <span className="px-event__time">{eventTime(event)}</span>
                    <span className={`px-event__dot${dotClass(event.level)}`} aria-hidden="true" />
                    <div className="px-event__text">
                      <Text size="small">{event.title ?? event.kind ?? 'event'}</Text>
                      {event.message ? <p className="px-event__message">{event.message}</p> : null}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Section>
        </div>
      </Panel>

      <Dialog
        open={confirming}
        onOpenChange={setConfirming}
        tone="danger"
        icon="!"
        title="Cancel this run"
        description="The agent stops where it is. Anything it already pushed or commented stays; nothing is rolled back."
        meta={data.id}
        confirmLabel="cancel run"
        cancelLabel="let it finish"
        onConfirm={() => void cancel()}
      />

      <Dialog
        open={denying}
        onOpenChange={setDenying}
        tone="danger"
        icon="!"
        title="Deny this request"
        description="The agent is told no and decides what to do about it, which is usually to stop. Approving instead lets it finish the task it is in the middle of."
        meta={wants ?? data.id}
        confirmLabel="deny"
        cancelLabel="go back"
        onConfirm={() => void answer('deny')}
      />
    </>
  )
}
