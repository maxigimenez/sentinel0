import { useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { Select } from '@16-bits-design/ui/select'
import { Text } from '@16-bits-design/ui/typography'
import { useToast } from '@16-bits-design/ui/toast'
import { api } from '../api/endpoints.js'
import { useKey } from '../lib/session.js'
import { useResource } from '../lib/useResource.js'
import {
  EMPTY_DRAFT,
  draftProblems,
  draftToNewRoute,
  placeholderValues,
  preservedParts,
} from '../lib/routeDraft.js'
import { fillRouteTemplate } from '../lib/routeTemplate.js'
import { ErrorPanel } from '../components/ErrorPanel.js'
import { Spinner } from '@16-bits-design/ui/spinner'
import { PageHeader } from '../components/PageHeader.js'
import { Panel, Section } from '../components/Panel.js'
import { RouteForm, type RouteDraft } from '../components/RouteForm.js'

/**
 * Creating a route, on its own page.
 *
 * A template is picked first because the combinations that actually fire are a
 * small subset of what the schema permits — the catalog is that subset, checked
 * in CI against the API's own validator. The form then asks only for the values
 * the template declares.
 */
export function RouteNew(): ReactNode {
  const key = useKey()
  const navigate = useNavigate()
  const { toast } = useToast()

  const templates = useResource((k, signal) => api.routeTemplates(k, signal), [])
  const projects = useResource((k, signal) => api.projects(k, signal), [])
  const agents = useResource((k, signal) => api.agents(k, signal), [])
  const prompts = useResource((k, signal) => api.promptTemplates(k, signal), [])

  const [templateId, setTemplateId] = useState('')
  const [draft, setDraft] = useState<RouteDraft>(EMPTY_DRAFT)
  // Once the prompt has been typed in, it stops tracking the template.
  const [promptEdited, setPromptEdited] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  const template = useMemo(
    () => (templates.data ?? []).find((entry) => entry.id === templateId),
    [templates.data, templateId]
  )
  const extraTokens = template?.placeholders.map((placeholder) => placeholder.token) ?? []

  /** The template's prompt with the current selections substituted in. */
  const derivedPrompt = (next: RouteDraft): string =>
    template
      ? (fillRouteTemplate(template, placeholderValues(next)).execution?.prompt ?? '')
      : next.prompt

  const pickTemplate = (id: string): void => {
    const picked = (templates.data ?? []).find((entry) => entry.id === id)
    setTemplateId(id)
    setError(undefined)
    setPromptEdited(false)
    setDraft({
      ...EMPTY_DRAFT,
      name: picked?.route.name ?? '',
      priority: String(picked?.route.priority ?? 100),
      timeoutSeconds: String(picked?.route.execution?.timeoutSeconds ?? 1800),
      prompt: picked?.route.execution?.prompt ?? '',
    })
  }

  // Until the prompt is edited it follows the selections, so choosing a project
  // replaces `<PROJECT_ID>` in the prompt instead of leaving a token to notice
  // later. After an edit it is left alone — nothing the user typed is discarded.
  const changeDraft = (next: RouteDraft): void => {
    const edited = promptEdited || next.prompt !== draft.prompt
    setPromptEdited(edited)
    setDraft(edited ? next : { ...next, prompt: derivedPrompt(next) })
  }

  const create = async (): Promise<void> => {
    if (!template) {
      return
    }
    const problems = draftProblems(draft, extraTokens)
    if (problems.length > 0) {
      setError(problems.join(' '))
      return
    }
    setSaving(true)
    setError(undefined)
    try {
      const created = await api.createRoute(key, draftToNewRoute(template, draft))
      toast({
        tone: 'success',
        title: 'Route created',
        message: `${created.name} will be picked up on the runner's next poll.`,
      })
      navigate('/routes')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  const loading = templates.loading || projects.loading || agents.loading || prompts.loading
  const failure = templates.error ?? projects.error ?? agents.error ?? prompts.error

  return (
    <>
      <PageHeader title="New route" parent={{ label: 'Routes', to: '/routes' }} />
      <Panel caption="When this happens, start that agent">
        {loading ? (
          <Spinner label="Loading templates" />
        ) : failure ? (
          <ErrorPanel message={failure} onRetry={templates.reload} />
        ) : (
          <div className="px-panel__body">
            <Section title="Supported case">
              <Select
                label="Start from"
                placeholder="Pick a supported case"
                value={templateId}
                onValueChange={pickTemplate}
                options={(templates.data ?? []).map((entry) => ({
                  value: entry.id,
                  label: entry.name,
                }))}
              />
              <Text size="small" tone="muted">
                {template?.description ??
                  'Every template is a complete route, checked against the API’s own validator. Pick one and fill in what it asks for.'}
              </Text>
            </Section>

            {template ? (
              <RouteForm
                mode="create"
                draft={draft}
                onChange={changeDraft}
                projects={projects.data ?? []}
                agents={agents.data ?? []}
                variables={prompts.data?.variables ?? []}
                extraTokens={extraTokens}
                requiresRepository={template.route.execution?.requireRepository}
                preserved={preservedParts(
                  fillRouteTemplate(template, placeholderValues(draft)) as never
                )}
                error={error}
                saving={saving}
                onSubmit={() => void create()}
                onCancel={() => navigate('/routes')}
              />
            ) : null}
          </div>
        )}
      </Panel>
    </>
  )
}
