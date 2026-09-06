import { useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Badge } from '@16-bits-design/ui/badge'
import { Button } from '@16-bits-design/ui/button'
import { Dialog } from '@16-bits-design/ui/dialog'
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
import { useKey } from '../lib/session.js'
import { useResource } from '../lib/useResource.js'
import { EmptyState } from '@16-bits-design/ui/empty-state'
import { ErrorPanel } from '../components/ErrorPanel.js'
import { Spinner } from '@16-bits-design/ui/spinner'
import { PageHeader } from '../components/PageHeader.js'
import { Panel } from '../components/Panel.js'
import type { RoutingRule } from '../api/types.js'

/** What exists. Creating and editing each have their own page. */
export function RouteList(): ReactNode {
  const key = useKey()
  const navigate = useNavigate()
  const { toast } = useToast()
  const routes = useResource((k, signal) => api.routes(k, signal), [])
  const [deleting, setDeleting] = useState<RoutingRule | undefined>(undefined)

  const remove = async (route: RoutingRule): Promise<void> => {
    try {
      await api.deleteRoute(key, route.id)
      toast({
        tone: 'success',
        title: 'Route deleted',
        message: `${route.name} will not fire again.`,
      })
      routes.reload()
    } catch (error) {
      toast({
        tone: 'danger',
        title: 'Could not delete the route',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return (
    <>
      <PageHeader
        title="Routes"
        parent={{ label: 'Overview', to: '/' }}
        actions={<Button onClick={() => navigate('/routes/new')}>new route</Button>}
      />
      <Panel caption="When this happens, start that agent">
        {routes.loading ? (
          <Spinner label="Loading routes" />
        ) : routes.error ? (
          <ErrorPanel message={routes.error} onRetry={routes.reload} />
        ) : (routes.data ?? []).length === 0 ? (
          <EmptyState
            title="No routes yet"
            action={
              <Button size="sm" onClick={() => navigate('/routes/new')}>
                new route
              </Button>
            }
          >
            Nothing will start an agent until a route exists.
          </EmptyState>
        ) : (
          <Table scrollLabel="Routes" containerClassName="px-tablewrap" minWidth={560}>
            <TableHead>
              <TableRow>
                <TableHeader>Route</TableHeader>
                <TableHeader>Trigger</TableHeader>
                <TableHeader>Agent</TableHeader>
                <TableHeader align="end">Priority</TableHeader>
                <TableHeader>
                  <span className="px-visually-hidden">Actions</span>
                </TableHeader>
              </TableRow>
            </TableHead>
            <TableBody>
              {(routes.data ?? []).map((route) => (
                <TableRow key={route.id}>
                  <TableCell>
                    <Link to={`/routes/${route.id}/edit`} className="px-rowlink">
                      <TableCellContent primary={route.name} secondary={route.id} />
                    </Link>
                  </TableCell>
                  <TableCell>
                    <TableCellContent
                      primary={route.trigger?.type}
                      secondary={route.trigger?.projectId ?? 'any project'}
                    />
                  </TableCell>
                  <TableCell>
                    <Text size="small" tone="soft" className="px-cellclip">
                      {route.target?.agentRef?.profile ??
                        route.target?.agentRef?.githubLogin ??
                        '—'}
                    </Text>
                  </TableCell>
                  <TableCell align="end">
                    <Text size="small" tone="soft">
                      {route.priority}
                    </Text>
                  </TableCell>
                  <TableCell>
                    <div className="px-rowactions">
                      <Badge tone={route.enabled ? 'success' : 'neutral'}>
                        {route.enabled ? 'enabled' : 'disabled'}
                      </Badge>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => navigate(`/routes/${route.id}/edit`)}
                        aria-label={`Edit route ${route.name}`}
                      >
                        edit
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setDeleting(route)}
                        aria-label={`Delete route ${route.name}`}
                      >
                        delete
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Panel>

      <Dialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(undefined)}
        tone="danger"
        icon="!"
        title="Delete this route"
        description="It stops firing immediately. Runs it already started are kept, and nothing they did is undone."
        meta={deleting?.name}
        confirmLabel="delete route"
        cancelLabel="keep it"
        onConfirm={() => {
          if (deleting) {
            void remove(deleting)
          }
          setDeleting(undefined)
        }}
      />
    </>
  )
}
