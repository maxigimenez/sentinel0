import chalk from 'chalk'
import { RUN_STATUS, type RunRecord, type RunStatus } from '@sentinel0/common'
import { getJson, runnerUnreachable } from '../api.js'
import type { CliContext, RunsCommandOptions } from '../types.js'

const STATUS_COLOR: Record<RunStatus, (text: string) => string> = {
  [RUN_STATUS.QUEUED]: chalk.dim,
  [RUN_STATUS.RUNNING]: chalk.blue,
  [RUN_STATUS.AWAITING_APPROVAL]: chalk.yellow,
  [RUN_STATUS.COMPLETED]: chalk.green,
  [RUN_STATUS.FAILED]: chalk.red,
  [RUN_STATUS.CANCELED]: chalk.dim,
}

function ago(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000))
  if (seconds < 60) {
    return `${seconds}s ago`
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m ago`
  }
  if (seconds < 86400) {
    return `${Math.floor(seconds / 3600)}h ago`
  }
  return `${Math.floor(seconds / 86400)}d ago`
}

export async function runRuns(context: CliContext, options: RunsCommandOptions): Promise<void> {
  const apiBase = await context.resolveDefaultApiBase()
  const query = new URLSearchParams({ limit: String(options.limit) })
  if (options.status) {
    query.set('status', options.status)
  }

  const { runs } = await getJson<{ runs: RunRecord[] }>(`${apiBase}/runs?${query}`).catch(() => {
    throw runnerUnreachable(apiBase)
  })

  if (runs.length === 0) {
    console.log(chalk.yellow('No runs yet.'))
    return
  }

  console.log('')
  for (const run of runs) {
    const color = STATUS_COLOR[run.status] ?? chalk.white
    console.log(
      `  ${color(run.status.padEnd(18))} ${chalk.bold(run.agentProfile.padEnd(12))} ${run.triggerRef}`
    )
    console.log(chalk.dim(`      ${run.id}  ${run.title}  ·  ${ago(run.updatedAt)}`))
    if (run.hermesRunId) {
      // The Hermes ids were always fetched here and never shown, which is
      // exactly what someone needs to look at the other side of a run.
      const session = run.hermesSessionId ? `  session ${run.hermesSessionId}` : ''
      console.log(chalk.dim(`      hermes ${run.hermesRunId}${session}`))
    }
    if (run.status === RUN_STATUS.AWAITING_APPROVAL) {
      const wants = run.approvalDetail?.command ?? run.approvalDetail?.tool
      console.log(chalk.yellow(`      waiting for approval${wants ? `: ${wants}` : ''}`))
      console.log(chalk.dim(`      sentinel0 approve ${run.id}`))
    }
    if (run.summary) {
      console.log(chalk.dim(`      ${run.summary.split('\n')[0].slice(0, 100)}`))
    }
    if (run.error) {
      console.log(chalk.red(`      ${run.error.split('\n')[0].slice(0, 100)}`))
    }
  }
  console.log('')
  console.log(chalk.dim('  sentinel0 logs --run <id>    full output for one run'))
  console.log(chalk.dim('  sentinel0 approve <id>       answer an agent waiting on you'))
  console.log('')
}
