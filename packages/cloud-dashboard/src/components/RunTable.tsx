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
import { Text } from '@16-bits-design/ui/typography'
import type { Run } from '../api/types.js'
import { duration, initials, relativeTime, STATUS_TONE } from '../lib/format.js'

/**
 * The run list, shared by the overview and the runs screen.
 *
 * There is deliberately no progress column. The API reports a status and two
 * timestamps, not a percentage, and a bar drawn from a status would be an
 * invented number on the screen people use to decide whether something is
 * stuck. Elapsed time is the honest version, and it is the figure that actually
 * tells you a run has hung.
 */
export function RunTable({ runs, now }: { runs: Run[]; now: number }): ReactNode {
  return (
    <Table scrollLabel="Runs" containerClassName="px-tablewrap" minWidth={560}>
      <TableHead>
        <TableRow>
          <TableHeader>Trigger</TableHeader>
          <TableHeader>Agent</TableHeader>
          <TableHeader>Route</TableHeader>
          <TableHeader>Elapsed</TableHeader>
          <TableHeader>Status</TableHeader>
        </TableRow>
      </TableHead>
      <TableBody>
        {runs.map((run) => {
          const profile = run.agent_profile ?? 'unassigned'
          return (
            <TableRow key={run.id}>
              <TableCell>
                <Link to={`/runs/${run.id}`} className="px-rowlink">
                  <TableCellContent
                    primary={run.title ?? run.trigger_ref ?? run.id}
                    secondary={
                      [run.trigger_ref, run.project_id].filter(Boolean).join(' · ') || run.id
                    }
                  />
                </Link>
              </TableCell>
              <TableCell>
                <span className="px-agentcell">
                  <Avatar name={profile} initials={initials(profile)} size="sm" />
                  <TableCellContent
                    primary={profile}
                    secondary={run.agent_profile ? 'hermes profile' : 'no agent'}
                  />
                </span>
              </TableCell>
              <TableCell>
                <Text size="small" tone="soft" className="px-cellclip">
                  {run.route_name ?? '—'}
                </Text>
              </TableCell>
              <TableCell>
                <TableCellContent
                  primary={
                    <Text size="caption" tone="soft">
                      {duration(run.started_at, run.ended_at, now)}
                    </Text>
                  }
                  secondary={relativeTime(run.updated_at, now)}
                />
              </TableCell>
              <TableCell>
                <Badge tone={STATUS_TONE[run.status] ?? 'neutral'}>
                  {run.status.replace(/_/g, ' ')}
                </Badge>
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}
