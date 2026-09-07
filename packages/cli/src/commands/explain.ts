import chalk from 'chalk'
import type { TriggerChanges, TriggerType } from '@sentinel0/common'
import { ApiError, getJson, runnerUnreachable } from '../api.js'
import type { CliContext, ExplainCommandOptions } from '../types.js'

interface Verdict {
  routeId: string
  routeName: string
  matched: boolean
  reason?: string
}

interface ExplainItem {
  ref: string
  type: TriggerType
  projectId: string
  title: string
  url?: string
  labels: string[]
  assignees: string[]
  requestedReviewers: string[]
  changes?: TriggerChanges
  verdicts: Verdict[]
}

/** Only the transitions that actually happened, so an empty cycle stays quiet. */
function describeChanges(changes: TriggerChanges | undefined): string {
  if (!changes) {
    return chalk.yellow('never polled before — transition rules cannot match yet')
  }
  const parts = [
    ['+label', changes.labelsAdded],
    ['-label', changes.labelsRemoved],
    ['+assignee', changes.assigneesAdded],
    ['-assignee', changes.assigneesRemoved],
    ['+reviewer', changes.reviewersAdded],
  ] as const

  const moved = parts
    .filter(([, values]) => values.length > 0)
    .map(([name, values]) => `${name} ${values.join(', ')}`)

  return moved.length > 0 ? moved.join('  ') : chalk.dim('nothing changed since the last poll')
}

export async function runExplain(
  context: CliContext,
  options: ExplainCommandOptions
): Promise<void> {
  const apiBase = await context.resolveDefaultApiBase()
  const query = new URLSearchParams()
  if (options.projectId) {
    query.set('project', options.projectId)
  }
  if (options.ref) {
    query.set('ref', options.ref)
  }

  const suffix = query.size > 0 ? `?${query}` : ''
  const { items } = await getJson<{ items: ExplainItem[] }>(
    `${apiBase}/routes/explain${suffix}`
  ).catch((error: unknown) => {
    // An unknown project, or a tracker that will not answer, is the runner
    // explaining itself and worth passing through verbatim. Anything else means
    // it is not there at all, which needs the other sentence entirely.
    if (error instanceof ApiError) {
      throw error
    }
    throw runnerUnreachable(apiBase)
  })

  if (items.length === 0) {
    console.log(chalk.yellow('\n  No triggers are visible right now.'))
    console.log(chalk.dim('  sentinel0 projects    check what this runner is polling\n'))
    return
  }

  console.log('')
  for (const item of items) {
    const matched = item.verdicts.filter((verdict) => verdict.matched)
    const mark = matched.length > 0 ? chalk.green('*') : chalk.dim('-')

    console.log(`  ${mark} ${chalk.bold(item.ref)} ${chalk.dim(item.type)}  ${item.title}`)
    console.log(chalk.dim(`      changed  ${describeChanges(item.changes)}`))
    if (item.requestedReviewers.length > 0) {
      console.log(chalk.dim(`      reviewers ${item.requestedReviewers.join(', ')}`))
    }

    for (const verdict of item.verdicts) {
      if (verdict.matched) {
        console.log(
          chalk.green(`      matches  ${verdict.routeName} ${chalk.dim(`(${verdict.routeId})`)}`)
        )
      } else {
        console.log(chalk.dim(`      skips    ${verdict.routeName}: ${verdict.reason}`))
      }
    }
    console.log('')
  }

  // A matching route is not a dispatched one, and conflating the two sends
  // people back to the rule engine to debug a busy agent.
  console.log(
    chalk.dim('  A matching route still defers if its agent is busy, or is a no-op if it')
  )
  console.log(chalk.dim('  already fired for this revision. sentinel0 logs shows which.\n'))
}
