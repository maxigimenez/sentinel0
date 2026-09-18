import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useToast } from '@16-bits-design/ui/toast'
import { api } from '../api/endpoints.js'
import { useKey } from '../lib/session.js'
import { useResource } from '../lib/useResource.js'
import {
  EMPTY_DRAFT,
  applyDraft,
  draftProblems,
  preservedParts,
  toDraft,
} from '../lib/routeDraft.js'
import { ErrorPanel } from '../components/ErrorPanel.js'
import { Spinner } from '@16-bits-design/ui/spinner'
import { PageHeader } from '../components/PageHeader.js'
import { Panel } from '../components/Panel.js'
import { RouteForm, type RouteDraft } from '../components/RouteForm.js'

/**
 * Editing a route.
 *
 * The loaded rule is the base: the form owns name, project, agent, priority,
 * enabled, timeout and prompt, and everything else — the match clauses, the
 * guard that stops a route re-firing on its own work, the outcome — is written
 * back untouched. Renaming a route must never quietly drop its loop guard.
 */
export function RouteEdit(): ReactNode {
  const { id = '' } = useParams()
  const key = useKey()
  const navigate = useNavigate()
  const { toast } = useToast()

  const route = useResource((k, signal) => api.route(k, id, signal), [id])
  const projects = useResource((k, signal) => api.projects(k, signal), [])
  const agents = useResource((k, signal) => api.agents(k, signal), [])
  const prompts = useResource((k, signal) => api.promptTemplates(k, signal), [])

  const [draft, setDraft] = useState<RouteDraft>(EMPTY_DRAFT)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  // Seeded once. The resource polls nothing, but a reload after a failed save
  // must not discard what the user has since typed.
  useEffect(() => {
    if (route.data && !loaded) {
      setDraft(toDraft(route.data))
      setLoaded(true)
    }
  }, [route.data, loaded])

  const save = async (): Promise<void> => {
    if (!route.data) {
      return
    }
    const problems = draftProblems(draft, identityTokens)
    if (problems.length > 0) {
      setError(problems.join(' '))
      return
    }
    setSaving(true)
    setError(undefined)
    try {
      const saved = await api.updateRoute(key, id, applyDraft(route.data, draft))
      toast({
        tone: 'success',
        title: 'Route saved',
        message: `${saved.name} takes effect on the runner's next poll.`,
      })
      navigate('/routes')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  const loading = route.loading || projects.loading || agents.loading || prompts.loading
  const failure = route.error ?? projects.error ?? agents.error ?? prompts.error
  const identityTokens = route.data?.target?.agentRef?.linearUserId
    ? ['<LINEAR_USER_ID>', '<LINEAR_WORKSPACE_ID>']
    : route.data?.target?.agentRef?.githubLogin
      ? ['<AGENT_GITHUB_LOGIN>']
      : []

  return (
    <>
      <PageHeader title={route.data?.name ?? 'Route'} parent={{ label: 'Routes', to: '/routes' }} />
      <Panel caption={route.data ? `${route.data.trigger?.type} · ${id}` : 'Loading this route'}>
        {loading ? (
          <Spinner label="Loading route" />
        ) : failure || !route.data ? (
          <ErrorPanel message={failure ?? `Route "${id}" was not found.`} onRetry={route.reload} />
        ) : (
          <div className="px-panel__body">
            <RouteForm
              mode="edit"
              draft={draft}
              onChange={setDraft}
              projects={projects.data ?? []}
              agents={agents.data ?? []}
              variables={prompts.data?.variables ?? []}
              extraTokens={identityTokens}
              requiresRepository={route.data.execution?.requireRepository}
              preserved={preservedParts(route.data)}
              error={error}
              saving={saving}
              onSubmit={() => void save()}
              onCancel={() => navigate('/routes')}
            />
          </div>
        )}
      </Panel>
    </>
  )
}
