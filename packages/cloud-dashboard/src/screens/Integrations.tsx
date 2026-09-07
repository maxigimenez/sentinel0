import { useState, type ReactNode } from 'react'
import { Alert } from '@16-bits-design/ui/alert'
import { Badge } from '@16-bits-design/ui/badge'
import { Button } from '@16-bits-design/ui/button'
import { Dialog } from '@16-bits-design/ui/dialog'
import { Input } from '@16-bits-design/ui/input'
import { Select } from '@16-bits-design/ui/select'
import { Spinner } from '@16-bits-design/ui/spinner'
import { Text } from '@16-bits-design/ui/typography'
import { useToast } from '@16-bits-design/ui/toast'
import { api } from '../api/endpoints.js'
import { useKey } from '../lib/session.js'
import { useResource } from '../lib/useResource.js'
import { relativeTime } from '../lib/format.js'
import { ErrorPanel } from '../components/ErrorPanel.js'
import { PageHeader } from '../components/PageHeader.js'
import { Panel, Section } from '../components/Panel.js'
import type { Integration, Project } from '../api/types.js'

/** What a person needs to know before pasting a token, per provider. */
const PROVIDERS = {
  github: {
    label: 'GitHub',
    field: 'Personal access token',
    placeholder: 'github_pat_… or ghp_…',
    hint: 'A fine-grained token with Issues: read and write, and Pull requests: read. Nothing more — Sentinel0 never pushes code; the agents do that under their own accounts.',
    docs: 'https://github.com/settings/personal-access-tokens',
  },
  linear: {
    label: 'Linear',
    field: 'API key',
    placeholder: 'lin_api_…',
    hint: 'A personal API key from Linear’s settings. Used to read issues and to comment and label as Sentinel0.',
    docs: 'https://linear.app/settings/api',
  },
} as const

type ProviderId = keyof typeof PROVIDERS

/**
 * Tracker credentials, and the Slack webhook that sits beside them.
 *
 * The organization holds one credential per provider, and any project may
 * override it. That is what makes a single token cover every repository while
 * one project — a different GitHub account, a separate Linear workspace — can
 * still carry its own.
 *
 * Nothing here can show a token back. The API stores them encrypted and
 * returns only a prefix, so this reports which credential is installed and
 * lets it be replaced, exactly as the Slack webhook already did.
 */
export function Integrations(): ReactNode {
  const key = useKey()
  const { toast } = useToast()
  const integrations = useResource((k, signal) => api.integrations(k, signal), [])
  const projects = useResource((k, signal) => api.projects(k, signal), [])
  const slack = useResource((k, signal) => api.slack(k, signal), [])

  return (
    <>
      <PageHeader title="Integrations" parent={{ label: 'Settings', to: '/settings' }} />
      <Panel caption="Credentials the runner and this dashboard authenticate with">
        <div className="px-panel__body">
          {integrations.loading ? (
            <Spinner label="Loading integrations" />
          ) : integrations.error ? (
            <ErrorPanel message={integrations.error} onRetry={integrations.reload} />
          ) : (
            (Object.keys(PROVIDERS) as ProviderId[]).map((provider) => (
              <ProviderSection
                key={provider}
                provider={provider}
                credentials={(integrations.data ?? []).filter(
                  (credential) => credential.provider === provider
                )}
                projects={projects.data ?? []}
                onChange={integrations.reload}
              />
            ))
          )}

          <SlackSection
            configured={slack.data?.configured ?? false}
            createdAt={slack.data?.created_at ?? null}
            loading={slack.loading}
            error={slack.error}
            onReload={slack.reload}
            onSave={async (webhookUrl) => {
              await api.saveSlack(key, { webhookUrl, enabled: true })
              toast({
                tone: 'success',
                title: 'Slack connected',
                message: 'Run notifications will post to that channel.',
              })
              slack.reload()
            }}
            onDisconnect={async () => {
              await api.deleteSlack(key)
              toast({
                tone: 'info',
                title: 'Slack disconnected',
                message: 'No further runs will be posted.',
              })
              slack.reload()
            }}
          />
        </div>
      </Panel>
    </>
  )
}

/**
 * One provider: the organization default, then any project overrides.
 *
 * The two are the same form with a different scope, rather than two screens,
 * because they are the same decision — which account acts here — asked at two
 * levels.
 */
function ProviderSection({
  provider,
  credentials,
  projects,
  onChange,
}: {
  provider: ProviderId
  credentials: Integration[]
  projects: Project[]
  onChange: () => void
}): ReactNode {
  const key = useKey()
  const { toast } = useToast()
  const meta = PROVIDERS[provider]

  const [token, setToken] = useState('')
  const [scope, setScope] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [removing, setRemoving] = useState<Integration | undefined>(undefined)

  const orgDefault = credentials.find((credential) => credential.projectId === null)
  const overrides = credentials.filter((credential) => credential.projectId !== null)

  // Only projects on this provider can override its credential, and a project
  // that already has one is offered as a replacement rather than twice.
  const eligible = projects.filter((project) => project.provider === provider)

  const save = async (): Promise<void> => {
    if (!token.trim()) {
      setError(`Paste the ${meta.field.toLowerCase()} to save.`)
      return
    }
    setSaving(true)
    setError(undefined)
    try {
      const result = await api.saveIntegration(key, provider, {
        token: token.trim(),
        projectId: scope || null,
      })
      toast({
        tone: 'success',
        title: `${meta.label} connected`,
        // Naming the account is the confirmation that matters: pasting the
        // wrong one of two tokens is the mistake this catches.
        message: `Authenticated as ${result.accountLogin}.`,
      })
      setToken('')
      setScope('')
      onChange()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (credential: Integration): Promise<void> => {
    try {
      await api.deleteIntegration(key, provider, credential.projectId)
      toast({
        tone: 'info',
        title: `${meta.label} credential removed`,
        message: credential.projectId
          ? `${credential.projectId} falls back to the organization credential.`
          : 'Projects without their own credential can no longer be polled.',
      })
      onChange()
    } catch (cause) {
      toast({
        tone: 'danger',
        title: 'Could not remove the credential',
        message: cause instanceof Error ? cause.message : String(cause),
      })
    }
  }

  return (
    <>
      <Section title={meta.label}>
        <div className="px-form">
          <CredentialRow
            credential={orgDefault}
            label="Organization default"
            onRemove={() => setRemoving(orgDefault)}
          />

          {overrides.map((override) => (
            <CredentialRow
              key={override.projectId}
              credential={override}
              label={`Override · ${override.projectId}`}
              onRemove={() => setRemoving(override)}
            />
          ))}

          <div className="px-form__row">
            <Input
              label={meta.field}
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder={meta.placeholder}
              hint={meta.hint}
              autoComplete="off"
            />
            <Select
              label="Applies to"
              value={scope}
              onValueChange={setScope}
              options={[
                { value: '', label: 'The whole organization' },
                ...eligible.map((project) => ({
                  value: project.id,
                  label: `Only ${project.id}`,
                })),
              ]}
            />
          </div>

          {error ? (
            <Alert tone="danger" title={`${meta.label} was not connected`}>
              {error}
            </Alert>
          ) : null}

          <div className="px-form__actions">
            <Button onClick={() => void save()} loading={saving} loadingLabel="verifying">
              {orgDefault && !scope ? 'replace credential' : 'save credential'}
            </Button>
            <Button variant="ghost" onClick={() => window.open(meta.docs, '_blank', 'noreferrer')}>
              create one
            </Button>
          </div>
        </div>
      </Section>

      <Dialog
        open={removing !== undefined}
        onOpenChange={(open) => !open && setRemoving(undefined)}
        tone="danger"
        icon="!"
        title={`Remove this ${meta.label} credential`}
        description={
          removing?.projectId
            ? `${removing.projectId} will fall back to the organization credential.`
            : 'Every project without its own credential stops being polled until another is added.'
        }
        confirmLabel="remove"
        cancelLabel="keep it"
        onConfirm={() => {
          if (removing) {
            void remove(removing)
          }
          setRemoving(undefined)
        }}
      />
    </>
  )
}

/**
 * What is installed, without ever being what is installed.
 *
 * `lastError` is shown beside the badge rather than replacing it: a credential
 * that worked yesterday and is failing now is a different situation from one
 * that was never added, and collapsing the two costs an operator the diagnosis.
 */
function CredentialRow({
  credential,
  label,
  onRemove,
}: {
  credential: Integration | undefined
  label: string
  onRemove: () => void
}): ReactNode {
  if (!credential) {
    return (
      <div className="px-credential">
        <Badge tone="neutral">not connected</Badge>
        <Text size="caption" tone="muted">
          {label}
        </Text>
      </div>
    )
  }

  return (
    <div className="px-credential">
      <Badge tone={credential.lastError ? 'danger' : 'success'}>
        {credential.lastError ? 'failing' : 'connected'}
      </Badge>
      <Text size="caption" tone="soft">
        {label} · <code>{credential.tokenPrefix}…</code>
        {credential.accountLogin ? ` · ${credential.accountLogin}` : ''}
      </Text>
      <Text size="caption" tone="muted">
        added {relativeTime(credential.createdAt)}
      </Text>
      <Button size="sm" variant="ghost" onClick={onRemove}>
        remove
      </Button>
      {credential.lastError ? (
        <Alert tone="danger" title="The last use of this credential failed">
          {credential.lastError}
        </Alert>
      ) : null}
    </div>
  )
}

/**
 * Slack, kept as it was but moved here.
 *
 * It is not a tracker credential — it authenticates nothing and is never sent
 * to a runner — but it is the other thing an operator connects, and having it
 * on a different page than the two credentials beside it was the arrangement
 * this replaces.
 */
function SlackSection({
  configured,
  createdAt,
  loading,
  error,
  onReload,
  onSave,
  onDisconnect,
}: {
  configured: boolean
  createdAt: string | null
  loading: boolean
  error: string | undefined
  onReload: () => void
  onSave: (webhookUrl: string) => Promise<void>
  onDisconnect: () => Promise<void>
}): ReactNode {
  const [webhook, setWebhook] = useState('')
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [disconnecting, setDisconnecting] = useState(false)

  const save = async (): Promise<void> => {
    if (!webhook.trim()) {
      setFailure('Paste the incoming webhook URL Slack gave you.')
      return
    }
    setSaving(true)
    setFailure(undefined)
    try {
      await onSave(webhook.trim())
      setWebhook('')
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <Section title="Slack notifications">
        {loading ? (
          <Spinner label="Loading Slack settings" />
        ) : error ? (
          <ErrorPanel message={error} onRetry={onReload} />
        ) : (
          <div className="px-form">
            <div className="px-credential">
              <Badge tone={configured ? 'success' : 'neutral'}>
                {configured ? 'connected' : 'not connected'}
              </Badge>
              {configured ? (
                <Text size="caption" tone="muted">
                  added {relativeTime(createdAt)}
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
                configured
                  ? 'Saving replaces the existing webhook. The current one is never shown back.'
                  : 'Create one in Slack under Incoming Webhooks, then paste it here.'
              }
              autoComplete="off"
            />

            {failure ? (
              <Alert tone="danger" title="Slack was not updated">
                {failure}
              </Alert>
            ) : null}

            <div className="px-form__actions">
              <Button onClick={() => void save()} loading={saving} loadingLabel="saving">
                {configured ? 'replace webhook' : 'connect slack'}
              </Button>
              {configured ? (
                <Button variant="danger" onClick={() => setDisconnecting(true)}>
                  disconnect
                </Button>
              ) : null}
            </div>
          </div>
        )}
      </Section>

      <Dialog
        open={disconnecting}
        onOpenChange={setDisconnecting}
        tone="danger"
        icon="!"
        title="Disconnect Slack"
        description="Run notifications stop immediately. The webhook is deleted, so reconnecting means pasting it again."
        confirmLabel="disconnect"
        cancelLabel="keep it"
        onConfirm={() => void onDisconnect()}
      />
    </>
  )
}
