import chalk from 'chalk'
import {
  RUN_STATUS,
  isTerminalRunStatus,
  sleep,
  type RunLogEntry,
  type RunRecord,
} from '@sentinel0/common'
import { getJson, runnerUnreachable } from '../api.js'
import type { CliContext, LogsCommandOptions } from '../types.js'

const LEVEL_COLOR = {
  info: chalk.white,
  warning: chalk.yellow,
  error: chalk.red,
} as const

function render(entry: RunLogEntry): void {
  const time = new Date(entry.timestamp).toLocaleTimeString()
  const color = LEVEL_COLOR[entry.level] ?? chalk.white
  const title = entry.title ? chalk.cyan(`${entry.title} `) : ''
  console.log(`${chalk.dim(time)} ${entry.icon} ${title}${color(entry.message)}`)
}

/**
 * Tails one run, or the most recent one.
 *
 * Polls rather than streams: the runner has no socket layer any more, and a
 * 1s poll against local SQLite is cheaper than the machinery a stream needs.
 */
export async function runLogs(context: CliContext, options: LogsCommandOptions): Promise<void> {
  const apiBase = await context.resolveDefaultApiBase()

  let runId = options.runId
  if (!runId) {
    const { runs } = await getJson<{ runs: RunRecord[] }>(`${apiBase}/runs?limit=1`).catch(() => {
      throw runnerUnreachable(apiBase)
    })
    if (runs.length === 0) {
      console.log(chalk.yellow('No runs yet.'))
      return
    }
    runId = runs[0].id
    console.log(chalk.dim(`Showing ${runId} — ${runs[0].title}\n`))
  }

  let since = 0
  let announcedApproval = false
  for (;;) {
    const { events } = await getJson<{ events: RunLogEntry[] }>(
      `${apiBase}/runs/${runId}/events?since=${since}`
    )

    for (const entry of events) {
      render(entry)
      // +1 so the next poll does not replay the newest event.
      since = Math.max(since, entry.timestamp + 1)
    }

    if (!options.follow) {
      return
    }

    const { run } = await getJson<{ run: RunRecord }>(`${apiBase}/runs/${runId}`)
    if (isTerminalRunStatus(run.status)) {
      console.log(chalk.dim(`\nRun ${run.status}.`))
      return
    }

    // A run waiting on a person produces no further output until someone
    // answers, so a follow that says nothing is indistinguishable from a hung
    // agent. Say what is happening, and what unblocks it, exactly once.
    if (run.status === RUN_STATUS.AWAITING_APPROVAL && !announcedApproval) {
      announcedApproval = true
      const wants = run.approvalDetail?.command ?? run.approvalDetail?.tool
      console.log(chalk.yellow(`\nWaiting for approval${wants ? `: ${wants}` : ''}`))
      console.log(chalk.dim(`  sentinel0 approve ${runId}          let it proceed`))
      console.log(chalk.dim(`  sentinel0 approve ${runId} --deny   refuse\n`))
    } else if (run.status !== RUN_STATUS.AWAITING_APPROVAL) {
      announcedApproval = false
    }

    await sleep(1_000)
  }
}
