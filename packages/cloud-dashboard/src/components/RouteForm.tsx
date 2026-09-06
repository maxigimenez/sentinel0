import { useMemo, useState, type ReactNode } from 'react'
import { Button } from '@16-bits-design/ui/button'
import { Input } from '@16-bits-design/ui/input'
import { Select } from '@16-bits-design/ui/select'
import { Toggle } from '@16-bits-design/ui/toggle'
import { Text } from '@16-bits-design/ui/typography'
import type { Agent, Project, RoutingRule } from '../api/types.js'
import { Alert } from '@16-bits-design/ui/alert'
import { Code } from '@16-bits-design/ui/code'
import { PromptField } from './PromptField.js'
import { Section } from './Panel.js'

export interface RouteDraft {
  name: string
  projectId: string
  agentProfile: string
  agentGithubLogin: string
  priority: string
  enabled: boolean
  timeoutSeconds: string
  prompt: string
  /** Placeholders a template declared that no dropdown covers, e.g. a label. */
  extras: Record<string, string>
}

/**
 * Which control a template placeholder deserves.
 *
 * Three of the four tokens the catalog uses name things the API already knows
 * about, so they get a dropdown rather than a free-text box where a typo
 * produces a route that is structurally valid and can never match.
 */
export function controlFor(token: string): 'project' | 'agent' | 'agent-login' | 'text' {
  switch (token) {
    case '<PROJECT_ID>':
      return 'project'
    case '<AGENT_PROFILE>':
      return 'agent'
    case '<AGENT_GITHUB_LOGIN>':
      return 'agent-login'
    default:
      return 'text'
  }
}

/** A readable label for a placeholder token like `<LABEL>`. */
export function labelFor(token: string): string {
  const words = token.replace(/[<>]/g, '').toLowerCase().split('_')
  return words.join(' ').replace(/^./, (c) => c.toUpperCase())
}

export function RouteForm({
  mode,
  draft,
  onChange,
  projects,
  agents,
  variables,
  extraTokens,
  preserved,
  error,
  saving,
  onSubmit,
  onCancel,
}: {
  mode: 'create' | 'edit'
  draft: RouteDraft
  onChange: (draft: RouteDraft) => void
  projects: Project[]
  agents: Agent[]
  variables: string[]
  /** Free-text placeholders this template still needs, e.g. `<LABEL>`. */
  extraTokens: string[]
  /** The parts of the rule this form does not edit, shown so they are not a surprise. */
  preserved: Partial<RoutingRule>
  error?: string
  saving: boolean
  onSubmit: () => void
  onCancel: () => void
}): ReactNode {
  const [showPreserved, setShowPreserved] = useState(false)
  const set = (patch: Partial<RouteDraft>): void => onChange({ ...draft, ...patch })

  const needsLogin = extraTokens.includes('<AGENT_GITHUB_LOGIN>')
  const freeText = useMemo(
    () => extraTokens.filter((token) => controlFor(token) === 'text'),
    [extraTokens]
  )

  const projectOptions = projects.map((project) => ({
    value: project.id,
    label: `${project.id} · ${project.provider}`,
  }))
  const agentOptions = agents.map((agent) => ({
    value: agent.profile,
    label: agent.display_name ? `${agent.profile} · ${agent.display_name}` : agent.profile,
  }))

  // Selecting the agent is what fills a githubLogin target, so the two cannot
  // drift apart the way two free-text fields would.
  const chooseAgent = (profile: string): void => {
    const agent = agents.find((entry) => entry.profile === profile)
    set({ agentProfile: profile, agentGithubLogin: agent?.github_login ?? '' })
  }

  const selectedAgent = agents.find((entry) => entry.profile === draft.agentProfile)

  return (
    <>
      <Section title={mode === 'create' ? 'Route' : 'Edit route'}>
        <div className="px-form">
          <Input
            label="Name"
            value={draft.name}
            onChange={(event) => set({ name: event.target.value })}
            hint="Shown on every run this route starts."
          />

          <div className="px-form__row">
            {projects.length === 0 ? (
              <Input
                label="Project"
                value={draft.projectId}
                onChange={(event) => set({ projectId: event.target.value })}
                hint="No projects registered yet — add one first, or type its id."
              />
            ) : (
              <Select
                label="Project"
                placeholder="Pick a project"
                value={draft.projectId}
                onValueChange={(value) => set({ projectId: value })}
                options={projectOptions}
              />
            )}

            {agents.length === 0 ? (
              <Input
                label="Agent"
                value={draft.agentProfile}
                onChange={(event) => set({ agentProfile: event.target.value })}
                hint="No agents reported yet — start the runner, or type a profile name."
              />
            ) : (
              <Select
                label="Agent"
                placeholder="Pick an agent"
                value={draft.agentProfile}
                onValueChange={chooseAgent}
                options={agentOptions}
              />
            )}
          </div>

          {needsLogin ? (
            <Input
              label="Agent GitHub login"
              value={draft.agentGithubLogin}
              onChange={(event) => set({ agentGithubLogin: event.target.value })}
              hint={
                selectedAgent && !selectedAgent.github_login
                  ? `The runner reported no GitHub login for "${selectedAgent.profile}", so this route can never match it. Set githubLogin for that profile in the runner's config and reload; it cannot be set from here.`
                  : 'Filled from the selected agent. This route fires when that account is assigned to the item or asked to review it.'
              }
            />
          ) : null}

          {freeText.length > 0 ? (
            <div className="px-form__row">
              {freeText.map((token) => (
                <Input
                  key={token}
                  label={labelFor(token)}
                  value={draft.extras[token] ?? ''}
                  onChange={(event) =>
                    set({ extras: { ...draft.extras, [token]: event.target.value } })
                  }
                />
              ))}
            </div>
          ) : null}

          <div className="px-form__row">
            <Input
              label="Priority"
              inputMode="numeric"
              value={draft.priority}
              onChange={(event) => set({ priority: event.target.value })}
              hint="Highest wins; only one route fires per event."
            />
            <Input
              label="Timeout (seconds)"
              inputMode="numeric"
              value={draft.timeoutSeconds}
              onChange={(event) => set({ timeoutSeconds: event.target.value })}
              hint="The run is stopped on the Hermes side after this."
            />
          </div>

          <Toggle
            checked={draft.enabled}
            onCheckedChange={(enabled) => set({ enabled })}
            label={draft.enabled ? 'Enabled' : 'Disabled — this route will not fire'}
          />
        </div>
      </Section>

      <Section title="Prompt">
        <PromptField
          value={draft.prompt}
          onChange={(prompt) => set({ prompt })}
          variables={variables}
        />
      </Section>

      <Section title="Trigger, matching and outcome">
        <Text size="small" tone="muted">
          These come from the template and are kept as they are. They decide <em>when</em> the route
          fires and what happens afterwards — changing them safely means picking a different
          template, so this form does not edit them.
        </Text>
        <div>
          <Button size="sm" variant="ghost" onClick={() => setShowPreserved(!showPreserved)}>
            {showPreserved ? 'hide definition' : 'show definition'}
          </Button>
        </div>
        {showPreserved ? (
          <Code label="The parts of this route the form does not edit">
            {JSON.stringify(preserved, null, 2)}
          </Code>
        ) : null}
      </Section>

      {error ? (
        <Alert tone="danger" title="The route was not saved">
          {error}
        </Alert>
      ) : null}

      <div className="px-form__actions">
        <Button onClick={onSubmit} loading={saving} loadingLabel="saving">
          {mode === 'create' ? 'create route' : 'save changes'}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={saving}>
          cancel
        </Button>
      </div>
    </>
  )
}
