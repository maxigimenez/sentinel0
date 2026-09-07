import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { Alert } from '@16-bits-design/ui/alert'
import { Button } from '@16-bits-design/ui/button'
import { Input } from '@16-bits-design/ui/input'
import { Select } from '@16-bits-design/ui/select'
import { Spinner } from '@16-bits-design/ui/spinner'
import { Text } from '@16-bits-design/ui/typography'
import { Textarea } from '@16-bits-design/ui/textarea'
import { useToast } from '@16-bits-design/ui/toast'
import { api } from '../api/endpoints.js'
import { useKey } from '../lib/session.js'
import { useResource } from '../lib/useResource.js'
import { PageHeader } from '../components/PageHeader.js'
import { Panel, Section } from '../components/Panel.js'

/**
 * Registering a tracker for the runner to poll.
 *
 * `filters` used to be a free-form JSON textarea, hinted with "use {}". That
 * asked a person to know the filter schema, to spell a repository slug
 * correctly, and to guess which labels a repository actually has — and every
 * one of those is a mistake the API discovers hours later, as an empty poll.
 *
 * With a credential stored in the cloud, the API can answer all three, so this
 * asks GitHub instead of asking the operator. The JSON escape hatch is still
 * here, under a disclosure, because the filter shape differs by provider and
 * is still moving.
 */
export function ProjectNew(): ReactNode {
  const key = useKey()
  const navigate = useNavigate()
  const { toast } = useToast()

  const [provider, setProvider] = useState('github')
  const [repo, setRepo] = useState('')
  const [state, setState] = useState('open')
  const [labels, setLabels] = useState<string[]>([])
  const [team, setTeam] = useState('')
  const [raw, setRaw] = useState('')
  const [showRaw, setShowRaw] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  const repositories = useResource(
    (k, signal) =>
      provider === 'github' ? api.gitHubRepositories(k, signal) : Promise.resolve([]),
    [provider]
  )

  // Labels depend on the chosen repository, so they load on selection rather
  // than up front — there is no useful list before a repository is picked.
  const [availableLabels, setAvailableLabels] = useState<string[]>([])
  const [labelsError, setLabelsError] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (provider !== 'github' || !repo) {
      setAvailableLabels([])
      return
    }
    const controller = new AbortController()
    setLabelsError(undefined)
    api
      .gitHubLabels(key, repo, controller.signal)
      .then(setAvailableLabels)
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setLabelsError(cause instanceof Error ? cause.message : String(cause))
        }
      })
    return () => controller.abort()
  }, [key, provider, repo])

  // Changing repository invalidates the label selection: the names came from
  // the previous repository and almost certainly do not exist in this one.
  useEffect(() => setLabels([]), [repo])

  const id = provider === 'github' ? repo : team

  const buildFilters = (): Record<string, unknown> => {
    if (showRaw && raw.trim()) {
      return JSON.parse(raw) as Record<string, unknown>
    }
    if (provider === 'linear') {
      return team ? { team } : {}
    }
    const [owner, name] = repo.split('/')
    return {
      owner,
      repo: name,
      state,
      ...(labels.length > 0 ? { labels } : {}),
    }
  }

  const create = async (): Promise<void> => {
    if (!id.trim()) {
      setError(provider === 'github' ? 'Choose a repository.' : 'A Linear team key is required.')
      return
    }

    let filters: Record<string, unknown>
    try {
      filters = buildFilters()
    } catch {
      setError('The filter override must be valid JSON. Use {} for no filtering.')
      return
    }

    setSaving(true)
    setError(undefined)
    try {
      await api.createProject(key, { id: id.trim(), provider, filters })
      toast({
        tone: 'success',
        title: 'Project saved',
        message: `${id.trim()} will be polled from the runner's next cycle.`,
      })
      navigate('/projects')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  /*
   * A 409 from the repository list means no GitHub credential is stored. That
   * is not an error in this screen — it is a prerequisite, and saying so with
   * the link that fixes it beats a red panel repeating the status code.
   */
  const needsCredential = repositories.error?.includes('No GitHub credential')

  return (
    <>
      <PageHeader title="Add project" parent={{ label: 'Projects', to: '/projects' }} />
      <Panel caption="Where triggers come from">
        <div className="px-panel__body">
          <Section title="Project">
            <div className="px-form">
              <Select
                label="Provider"
                value={provider}
                onValueChange={setProvider}
                options={[
                  { value: 'github', label: 'GitHub' },
                  { value: 'linear', label: 'Linear' },
                ]}
              />

              {provider === 'github' ? (
                needsCredential ? (
                  <Alert tone="warning" title="No GitHub credential is configured">
                    Add one under <a href="/settings/integrations">Settings → Integrations</a>, then
                    come back — the repository list is read with it.
                  </Alert>
                ) : repositories.loading ? (
                  <Spinner label="Loading repositories" />
                ) : (
                  <>
                    <Select
                      label="Repository"
                      value={repo}
                      onValueChange={setRepo}
                      options={[
                        { value: '', label: 'Choose a repository…' },
                        ...(repositories.data ?? []).map((repository) => ({
                          value: repository.slug,
                          label: repository.private
                            ? `${repository.slug} (private)`
                            : repository.slug,
                        })),
                      ]}
                    />

                    <Select
                      label="Issue state"
                      value={state}
                      onValueChange={setState}
                      options={[
                        { value: 'open', label: 'Open' },
                        { value: 'closed', label: 'Closed' },
                        { value: 'all', label: 'All' },
                      ]}
                    />

                    <LabelPicker
                      available={availableLabels}
                      selected={labels}
                      onChange={setLabels}
                      disabled={!repo}
                      error={labelsError}
                    />
                  </>
                )
              ) : (
                <Input
                  label="Team key"
                  value={team}
                  onChange={(event) => setTeam(event.target.value)}
                  hint="The short key Linear shows on issue identifiers, e.g. ENG."
                  placeholder="ENG"
                />
              )}

              <div>
                <Button size="sm" variant="ghost" onClick={() => setShowRaw(!showRaw)}>
                  {showRaw ? 'use the pickers' : 'edit filters as JSON'}
                </Button>
              </div>

              {showRaw ? (
                <Textarea
                  label="Filters"
                  rows={5}
                  value={raw}
                  onChange={(event) => setRaw(event.target.value)}
                  hint="Overrides the choices above. JSON passed straight to the trigger source."
                />
              ) : null}

              {error ? (
                <Alert tone="danger" title="The project was not saved">
                  {error}
                </Alert>
              ) : null}

              <div className="px-form__actions">
                <Button onClick={() => void create()} loading={saving} loadingLabel="saving">
                  save project
                </Button>
                <Button variant="ghost" onClick={() => navigate('/projects')} disabled={saving}>
                  cancel
                </Button>
              </div>
            </div>
          </Section>
        </div>
      </Panel>
    </>
  )
}

/**
 * The repository's own labels, as toggles.
 *
 * Toggles rather than a multi-select because the set is small, the names are
 * the point, and a typed label that does not exist in the repository silently
 * matches nothing — which was the failure mode of the free-text field this
 * replaces. GitHub ANDs repeated labels, so selecting two narrows rather than
 * widens; the hint says so, because the opposite is the natural guess.
 */
function LabelPicker({
  available,
  selected,
  onChange,
  disabled,
  error,
}: {
  available: string[]
  selected: string[]
  onChange: (labels: string[]) => void
  disabled: boolean
  error: string | undefined
}): ReactNode {
  if (disabled) {
    return null
  }
  if (error) {
    return (
      <Alert tone="warning" title="Could not read the repository's labels">
        {error}
      </Alert>
    )
  }
  if (available.length === 0) {
    return (
      <Text size="caption" tone="muted">
        This repository has no labels, so there is nothing to pre-filter on.
      </Text>
    )
  }

  return (
    <div className="px-form__field">
      <span className="px-form__label">Pre-filter by label</span>
      <div className="px-labelpicker">
        {available.map((label) => {
          const on = selected.includes(label)
          return (
            <button
              key={label}
              type="button"
              className={`px-labelchip${on ? ' px-labelchip--on' : ''}`}
              aria-pressed={on}
              onClick={() =>
                onChange(on ? selected.filter((name) => name !== label) : [...selected, label])
              }
            >
              {label}
            </button>
          )
        })}
      </div>
      <Text size="caption" tone="muted">
        A coarse pre-filter — routes do the real matching. Selecting several narrows to issues
        carrying all of them.
      </Text>
    </div>
  )
}
