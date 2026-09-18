import type { RoutingRule, TriggerEvent } from '@sentinel0/common'
import { SUMMARY_SENTINEL } from './output-contract.js'

export interface PromptContext {
  event: TriggerEvent
  route: RoutingRule
  agentProfile: string
  agentRole?: string
}

/** Resolves a `{{path}}` placeholder against the trigger and agent. */
function resolveVariable(name: string, context: PromptContext): string | undefined {
  const { event } = context

  switch (name) {
    case 'ticket.ref':
      return event.ref
    case 'ticket.title':
      return event.title
    case 'ticket.body':
      return event.body.trim() || '(no description provided)'
    case 'ticket.url':
      return event.url ?? ''
    case 'ticket.state':
      return event.state ?? ''
    case 'ticket.labels':
      return event.labels.join(', ')
    case 'ticket.assignees':
      return (event.assignees ?? []).join(', ')
    case 'project.id':
      return event.projectId
    case 'repo.slug':
      // GitHub refs are `owner/repo#number`; anything else has no repo to name.
      return event.repository ?? event.ref.match(/^([^/]+\/[^#]+)#\d+$/)?.[1] ?? ''
    case 'agent.profile':
      return context.agentProfile
    case 'agent.role':
      return context.agentRole ?? ''
    case 'pr.number':
      return event.prNumber === undefined ? '' : String(event.prNumber)
    case 'pr.reviewers':
      return (event.requestedReviewers ?? []).join(', ')
    case 'pr.baseBranch':
      return event.baseBranch ?? ''
    case 'changes.labelsAdded':
      return (event.changes?.labelsAdded ?? []).join(', ')
    case 'changes.labelsRemoved':
      return (event.changes?.labelsRemoved ?? []).join(', ')
    case 'changes.assigneesAdded':
      return (event.changes?.assigneesAdded ?? []).join(', ')
    case 'changes.reviewersAdded':
      return (event.changes?.reviewersAdded ?? []).join(', ')
    default:
      return undefined
  }
}

export interface RenderResult {
  prompt: string
  /** Placeholders the template used that nothing could fill. */
  unknown: string[]
}

/**
 * Interpolates a route's prompt.
 *
 * An unrecognized placeholder is left in the text verbatim and reported rather
 * than silently blanked: a typo like `{{ticket.titel}}` reaching the agent as an
 * empty string produces a confidently wrong run, whereas leaving it visible
 * makes the mistake obvious in the transcript.
 */
export function renderPromptText(template: string, context: PromptContext): RenderResult {
  const unknown: string[] = []

  const prompt = template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, name: string) => {
    const value = resolveVariable(name, context)
    if (value === undefined) {
      unknown.push(name)
      return match
    }
    return value
  })

  return { prompt, unknown }
}

/**
 * The contract Sentinel0 needs back from every agent.
 *
 * Appended automatically unless the operator already asked for it, so a route
 * written without thinking about it still yields a usable ticket comment, and
 * one that words the instruction itself is not second-guessed.
 */
export function withSummaryContract(prompt: string): string {
  if (prompt.includes(SUMMARY_SENTINEL)) {
    return prompt
  }
  return [
    prompt.trimEnd(),
    '',
    'When you are done, end your reply with a single line:',
    `${SUMMARY_SENTINEL}: <one or two sentences on what you concluded or did>`,
    'Keep it short. Do not put code, diffs, or command output on that line.',
  ].join('\n')
}

export function renderRoutePrompt(context: PromptContext): RenderResult {
  const rendered = renderPromptText(context.route.execution.prompt, context)
  return { prompt: withSummaryContract(rendered.prompt), unknown: rendered.unknown }
}
