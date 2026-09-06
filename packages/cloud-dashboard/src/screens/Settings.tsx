import { useEffect, useState, type ReactNode } from 'react'
import { Badge } from '@16-bits-design/ui/badge'
import { Button } from '@16-bits-design/ui/button'
import { Dialog } from '@16-bits-design/ui/dialog'
import { Input } from '@16-bits-design/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableCellContent,
  TableHead,
  TableHeader,
  TableRow,
} from '@16-bits-design/ui/table'
import { Text } from '@16-bits-design/ui/typography'
import { useToast } from '@16-bits-design/ui/toast'
import { api } from '../api/endpoints.js'
import { API_URL } from '../config.js'
import { useKey, useSession } from '../lib/session.js'
import { useResource } from '../lib/useResource.js'
import { relativeTime, uptime } from '../lib/format.js'
import { Alert } from '@16-bits-design/ui/alert'
import { EmptyState } from '@16-bits-design/ui/empty-state'
import { ErrorPanel } from '../components/ErrorPanel.js'
import { Spinner } from '@16-bits-design/ui/spinner'
import { PageHeader } from '../components/PageHeader.js'
import { Panel, Section } from '../components/Panel.js'

/**
 * Organization-level configuration: Slack, and the runners reporting in.
 *
 * The Slack webhook is write-only. The API deliberately never returns it — it
 * is a credential that grants posting to a channel — so this reports whether
 * one is configured and lets it be replaced, but can never show it back.
 */
export function Settings(): ReactNode {
  const key = useKey()
  const { session } = useSession()
  const { toast } = useToast()
  const slack = useResource((k, signal) => api.slack(k, signal), [])
  const runners = useResource((k, signal) => api.runners(k, signal), [], { pollMs: 30_000 })

  const [webhook, setWebhook] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [disconnecting, setDisconnecting] = useState(false)

  // Uptime and "last seen" are both derived from now, so they need a clock of
  // their own — the runner data itself has not changed between ticks.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  const failing = (runners.data ?? []).filter((runner) => runner.last_error)

  const save = async (): Promise<void> => {
    if (!webhook.trim()) {
      setError('Paste the incoming webhook URL Slack gave you.')
      return
    }
    setSaving(true)
    setError(undefined)
    try {
      await api.saveSlack(key, { webhookUrl: webhook.trim(), enabled: true })
      toast({
        tone: 'success',
        title: 'Slack connected',
        message: 'Run notifications will post to that channel.',
      })
      setWebhook('')
      slack.reload()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  const disconnect = async (): Promise<void> => {
    try {
      await api.deleteSlack(key)
      toast({
        tone: 'info',
        title: 'Slack disconnected',
        message: 'No further runs will be posted.',
      })
      slack.reload()
    } catch (cause) {
      toast({
        tone: 'danger',
        title: 'Could not disconnect Slack',
        message: cause instanceof Error ? cause.message : String(cause),
      })
    }
  }

  return (
    <>
      <PageHeader title="Settings" parent={{ label: 'Overview', to: '/' }} />
      <Panel caption={`${session?.me.org.name ?? 'Organization'} · ${API_URL}`}>
        <div className="px-panel__body">
          <Section title="Organization">
            <dl className="px-kv">
              <dt>Name</dt>
              <dd>{session?.me.org.name ?? '—'}</dd>
              <dt>Id</dt>
              <dd>
                <code>{session?.me.org.id ?? '—'}</code>
              </dd>
              <dt>Control plane</dt>
              <dd>
                <code>{API_URL}</code>
              </dd>
              <dt>Signed in with</dt>
              <dd>
                {session?.me.key.name ?? 'a user key'} (<code>{session?.me.key.prefix}…</code>)
              </dd>
            </dl>
            <Text size="caption" tone="muted">
              The organization name is set when it is created with <code>org-cli.js</code>. There is
              no endpoint to rename it yet.
            </Text>
          </Section>

          <Section title="Slack notifications">
            {slack.loading ? (
              <Spinner label="Loading Slack settings" />
            ) : slack.error ? (
              <ErrorPanel message={slack.error} onRetry={slack.reload} />
            ) : (
              <div className="px-form">
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <Badge tone={slack.data?.configured ? 'success' : 'neutral'}>
                    {slack.data?.configured ? 'connected' : 'not connected'}
                  </Badge>
                  {slack.data?.configured ? (
                    <Text size="caption" tone="muted">
                      added {relativeTime(slack.data.created_at ?? null)}
                    </Text>
                  ) : null}
                </div>

                <Input
                  label="Incoming webhook URL"
                  type="url"
                  value={webhook}
                  onChange={(event) => setWebhook(event.target.value)}
                  placeholder="https://hooks.slack.com/services/…"
                  hint={
                    slack.data?.configured
                      ? 'Saving replaces the existing webhook. The current one is never shown back.'
                      : 'Create one in Slack under Incoming Webhooks, then paste it here.'
                  }
                  autoComplete="off"
                />

                {error ? (
                  <Alert tone="danger" title="Slack was not updated">
                    {error}
                  </Alert>
                ) : null}

                <div className="px-form__actions">
                  <Button onClick={() => void save()} loading={saving} loadingLabel="saving">
                    {slack.data?.configured ? 'replace webhook' : 'connect slack'}
                  </Button>
                  {slack.data?.configured ? (
                    <Button variant="danger" onClick={() => setDisconnecting(true)}>
                      disconnect
                    </Button>
                  ) : null}
                </div>
              </div>
            )}
          </Section>

          <Section title="Runners" padded={false}>
            {runners.loading ? (
              <Spinner label="Loading runners" />
            ) : runners.error ? (
              <ErrorPanel message={runners.error} onRetry={runners.reload} />
            ) : (runners.data ?? []).length === 0 ? (
              <EmptyState title="No runner has registered">
                Start one with <code>sentinel0 start</code> on the machine running Hermes. It
                registers itself on its first poll.
              </EmptyState>
            ) : (
              <Table
                scrollLabel="Registered runners"
                containerClassName="px-tablewrap"
                minWidth={520}
              >
                <TableHead>
                  <TableRow>
                    <TableHeader>Runner</TableHeader>
                    <TableHeader>Hermes</TableHeader>
                    <TableHeader align="end">Running</TableHeader>
                    <TableHeader>Uptime</TableHeader>
                    <TableHeader>Last seen</TableHeader>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {(runners.data ?? []).map((runner) => (
                    <TableRow key={runner.id}>
                      <TableCell>
                        <span className="px-agentcell">
                          <span
                            className={`px-runnerline__dot${
                              runner.stale
                                ? ' px-runnerline__dot--stale'
                                : runner.hermes_ok === false
                                  ? ' px-runnerline__dot--warn'
                                  : ''
                            }`}
                            aria-hidden="true"
                          />
                          <TableCellContent
                            primary={runner.name}
                            secondary={
                              [runner.hostname, runner.version].filter(Boolean).join(' · ') || '—'
                            }
                          />
                        </span>
                      </TableCell>
                      <TableCell>
                        {/*
                         * Null, not false, when the runner is too old to send
                         * a heartbeat. Reporting "unreachable" for "did not
                         * say" would be worse than saying nothing.
                         */}
                        {runner.hermes_ok === null ? (
                          <Text size="small" tone="faint">
                            not reported
                          </Text>
                        ) : (
                          <TableCellContent
                            primary={
                              <Badge tone={runner.hermes_ok ? 'success' : 'danger'}>
                                {runner.hermes_ok ? 'reachable' : 'unreachable'}
                              </Badge>
                            }
                            secondary={runner.hermes_detail ?? ''}
                          />
                        )}
                      </TableCell>
                      <TableCell align="end">
                        <Text size="small" tone="soft">
                          {runner.active_runs ?? '—'}
                        </Text>
                      </TableCell>
                      <TableCell>
                        <Text size="small" tone="soft">
                          {runner.started_at ? uptime(runner.started_at, now) : '—'}
                        </Text>
                      </TableCell>
                      <TableCell>
                        <TableCellContent
                          primary={
                            <Text size="caption" tone="soft">
                              {relativeTime(runner.last_seen_at, now)}
                            </Text>
                          }
                          secondary={runner.stale ? 'stale' : undefined}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Section>

          {failing.length > 0 ? (
            <Alert tone="danger" title="A runner reported an error on its last cycle">
              {failing.map((runner) => (
                <div key={runner.id}>
                  <strong>{runner.name}</strong>: {runner.last_error}
                </div>
              ))}
            </Alert>
          ) : null}
        </div>
      </Panel>

      <Dialog
        open={disconnecting}
        onOpenChange={setDisconnecting}
        tone="danger"
        icon="!"
        title="Disconnect Slack"
        description="Run notifications stop immediately. The webhook is deleted, so reconnecting means pasting it again."
        confirmLabel="disconnect"
        cancelLabel="keep it"
        onConfirm={() => void disconnect()}
      />
    </>
  )
}
