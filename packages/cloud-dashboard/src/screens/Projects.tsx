import { useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { Badge } from '@16-bits-design/ui/badge'
import { Button } from '@16-bits-design/ui/button'
import { Dialog } from '@16-bits-design/ui/dialog'
import { useToast } from '@16-bits-design/ui/toast'
import { api } from '../api/endpoints.js'
import { useKey } from '../lib/session.js'
import { useResource } from '../lib/useResource.js'
import {
  Table,
  TableBody,
  TableCell,
  TableCellContent,
  TableHead,
  TableHeader,
  TableRow,
} from '@16-bits-design/ui/table'
import { EmptyState } from '@16-bits-design/ui/empty-state'
import { ErrorPanel } from '../components/ErrorPanel.js'
import { Spinner } from '@16-bits-design/ui/spinner'
import { PageHeader } from '../components/PageHeader.js'
import { Panel } from '../components/Panel.js'
import { Text } from '@16-bits-design/ui/typography'
import type { Project } from '../api/types.js'

/**
 * A project's filters on one line.
 *
 * `owner/repo · labels: a, b` rather than the raw object: the filters are how
 * an operator recognises a row, and the JSON was three lines of punctuation to
 * say the same thing.
 */
function summarizeFilters(filters: Record<string, unknown> | null | undefined): string {
  const parts: string[] = []
  const value = (key: string): string | undefined => {
    const raw = filters?.[key]
    return typeof raw === 'string' && raw ? raw : undefined
  }

  const owner = value('owner')
  const repo = value('repo')
  if (owner && repo) {
    parts.push(`${owner}/${repo}`)
  }
  for (const key of ['team', 'project', 'state'] as const) {
    const found = value(key)
    if (found) {
      parts.push(`${key}: ${found}`)
    }
  }
  const labels = filters?.labels
  if (Array.isArray(labels) && labels.length > 0) {
    parts.push(`labels: ${labels.join(', ')}`)
  }

  return parts.length > 0 ? parts.join('  ·  ') : 'no filters'
}

export function Projects(): ReactNode {
  const key = useKey()
  const navigate = useNavigate()
  const { toast } = useToast()
  const projects = useResource((k, signal) => api.projects(k, signal), [])
  const [deleting, setDeleting] = useState<Project | undefined>(undefined)

  const remove = async (project: Project): Promise<void> => {
    try {
      await api.deleteProject(key, project.id)
      toast({
        tone: 'success',
        title: 'Project removed',
        message: `${project.id} is no longer polled.`,
      })
      projects.reload()
    } catch (cause) {
      toast({
        tone: 'danger',
        title: 'Could not remove the project',
        message: cause instanceof Error ? cause.message : String(cause),
      })
    }
  }

  return (
    <>
      <PageHeader
        title="Projects"
        parent={{ label: 'Overview', to: '/' }}
        actions={<Button onClick={() => navigate('/projects/new')}>add project</Button>}
      />
      <Panel caption="Where triggers come from">
        {projects.loading ? (
          <Spinner label="Loading projects" />
        ) : projects.error ? (
          <ErrorPanel message={projects.error} onRetry={projects.reload} />
        ) : (projects.data ?? []).length === 0 ? (
          <EmptyState
            title="No projects registered"
            action={
              <Button size="sm" onClick={() => navigate('/projects/new')}>
                add project
              </Button>
            }
          >
            The runner polls nothing until a project exists, so no route can ever fire.
          </EmptyState>
        ) : (
          <Table scrollLabel="Registered projects" containerClassName="px-tablewrap" minWidth={520}>
            <TableHead>
              <TableRow>
                <TableHeader>Project</TableHeader>
                <TableHeader>Provider</TableHeader>
                <TableHeader>Filters</TableHeader>
                <TableHeader>
                  <span className="px-visually-hidden">Actions</span>
                </TableHeader>
              </TableRow>
            </TableHead>
            <TableBody>
              {(projects.data ?? []).map((project) => (
                <TableRow key={project.id}>
                  <TableCell>
                    <TableCellContent primary={project.id} />
                  </TableCell>
                  <TableCell>
                    <Badge tone="outline">{project.provider}</Badge>
                  </TableCell>
                  <TableCell>
                    {/*
                     * One line, not pretty-printed JSON. A multi-line <Code>
                     * block in a table cell was the widest thing on the page
                     * and forced every projects table to scroll sideways.
                     */}
                    <Text size="small" tone="soft" className="px-cellclip">
                      {summarizeFilters(project.filters)}
                    </Text>
                  </TableCell>
                  <TableCell>
                    <div className="px-rowactions">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setDeleting(project)}
                        aria-label={`Remove project ${project.id}`}
                      >
                        remove
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
        title="Remove this project"
        description="The runner stops polling it, so no route can fire from it again. Existing runs are kept."
        meta={deleting?.id}
        confirmLabel="remove project"
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
