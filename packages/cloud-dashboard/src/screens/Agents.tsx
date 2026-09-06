import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Avatar } from '@16-bits-design/ui/avatar'
import { Badge } from '@16-bits-design/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableCellContent,
  TableHead,
  TableHeader,
  TableRow,
} from '@16-bits-design/ui/table'
import { api } from '../api/endpoints.js'
import type { Agent } from '../api/types.js'
import { useResource } from '../lib/useResource.js'
import { initials, relativeTime } from '../lib/format.js'
import { EmptyState } from '@16-bits-design/ui/empty-state'
import { ErrorPanel } from '../components/ErrorPanel.js'
import { Spinner } from '@16-bits-design/ui/spinner'
import { PageHeader } from '../components/PageHeader.js'
import { Panel } from '../components/Panel.js'

/**
 * The agent pool, as the runner last reported it.
 *
 * Read-only on purpose: agents are Hermes profiles discovered on the runner's
 * machine, not records anyone creates here. Editing one in the dashboard would
 * be overwritten by the next inventory push.
 */
/**
 * What an agent is doing, in one badge.
 *
 * `enabled` is configuration and was all this column ever showed, so a healthy
 * idle agent and one that had been wedged on an approval for an hour looked
 * identical. Liveness comes from the runner's heartbeat; the configuration flag
 * only wins when it is off, because a disabled agent is not going to do
 * anything whatever its last reported state was.
 */
function AgentState({ agent }: { agent: Agent }): ReactNode {
  if (!agent.enabled) {
    return <Badge tone="neutral">disabled</Badge>
  }
  if (agent.runner_stale || !agent.status) {
    return <Badge tone="neutral">unknown</Badge>
  }
  if (agent.status === 'awaiting_approval') {
    return (
      <Link to={`/runs/${agent.current_run_id ?? ''}`} className="px-rowlink">
        <Badge tone="amber">needs approval</Badge>
      </Link>
    )
  }
  if (agent.status === 'busy') {
    return (
      <Link to={`/runs/${agent.current_run_id ?? ''}`} className="px-rowlink">
        <Badge tone="primary">running</Badge>
      </Link>
    )
  }
  return <Badge tone="success">idle</Badge>
}

export function Agents(): ReactNode {
  const agents = useResource((key, signal) => api.agents(key, signal), [], { pollMs: 60_000 })

  return (
    <>
      <PageHeader title="Agents" parent={{ label: 'Overview', to: '/' }} />
      <Panel caption="Hermes profiles the runner has discovered">
        {agents.loading ? (
          <Spinner label="Loading agents" />
        ) : agents.error ? (
          <ErrorPanel message={agents.error} onRetry={agents.reload} />
        ) : (agents.data ?? []).length === 0 ? (
          <EmptyState title="No agents reported">
            The runner pushes its Hermes profiles when it starts. If this stays empty, check that
            the runner is running and that <code>sentinel0 agents</code> lists something locally.
          </EmptyState>
        ) : (
          <Table scrollLabel="Agents" containerClassName="px-tablewrap" minWidth={560}>
            <TableHead>
              <TableRow>
                <TableHeader>Agent</TableHeader>
                <TableHeader>Model</TableHeader>
                <TableHeader>GitHub</TableHeader>
                <TableHeader>Runner</TableHeader>
                <TableHeader>Doing</TableHeader>
              </TableRow>
            </TableHead>
            <TableBody>
              {(agents.data ?? []).map((agent) => (
                <TableRow key={agent.id}>
                  <TableCell>
                    <span className="px-agentcell">
                      <Avatar
                        name={agent.display_name ?? agent.profile}
                        initials={initials(agent.profile)}
                        src={agent.avatar_url ?? undefined}
                        alt={agent.avatar_url ? `${agent.profile} avatar` : undefined}
                        size="sm"
                      />
                      <TableCellContent
                        primary={agent.display_name ?? agent.profile}
                        secondary={agent.role ?? agent.profile}
                      />
                    </span>
                  </TableCell>
                  <TableCell>
                    <TableCellContent
                      primary={agent.model ?? 'â'}
                      secondary={agent.provider ?? 'hermes'}
                    />
                  </TableCell>
                  <TableCell>
                    <TableCellContent
                      primary={agent.github_login ?? 'not set'}
                      secondary={agent.github_login ? 'own account' : 'no PR routing'}
                    />
                  </TableCell>
                  <TableCell>
                    <TableCellContent
                      primary={agent.runner}
                      secondary={
                        agent.runner_stale
                          ? 'not checking in'
                          : `synced ${relativeTime(agent.synced_at)}`
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <AgentState agent={agent} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Panel>
    </>
  )
}
