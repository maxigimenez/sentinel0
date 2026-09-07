import { useEffect, useState, type ReactNode } from 'react'
import { Alert } from '@16-bits-design/ui/alert'
import { Badge } from '@16-bits-design/ui/badge'
import { EmptyState } from '@16-bits-design/ui/empty-state'
import { Spinner } from '@16-bits-design/ui/spinner'
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
import { api } from '../api/endpoints.js'
import { useResource } from '../lib/useResource.js'
import { relativeTime, uptime } from '../lib/format.js'
import { ErrorPanel } from '../components/ErrorPanel.js'
import { PageHeader } from '../components/PageHeader.js'
import { Panel, Section } from '../components/Panel.js'

/**
 * The machines checking in.
 *
 * Split out of Settings when the organization rail arrived: it was the only
 * table on a page of forms, and "is the Mac Mini still there" is a question
 * asked far more often than anything else that page held.
 */
export function Runners(): ReactNode {
  const runners = useResource((k, signal) => api.runners(k, signal), [], { pollMs: 30_000 })

  // Uptime and "last seen" are both derived from now, so they need a clock of
  // their own — the runner data itself has not changed between ticks.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  const failing = (runners.data ?? []).filter((runner) => runner.last_error)

  return (
    <>
      <PageHeader title="Runners" parent={{ label: 'Settings', to: '/settings' }} />
      <Panel caption="Machines running Hermes and polling for work">
        <div className="px-panel__body">
          <Section title="Registered runners" padded={false}>
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
    </>
  )
}
