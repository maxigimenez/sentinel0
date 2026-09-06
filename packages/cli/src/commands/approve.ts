import chalk from 'chalk'
import { APPROVAL_CHOICE } from '@sentinel0/common'
import { postJson, runnerUnreachable } from '../api.js'
import type { ApproveCommandOptions, CliContext } from '../types.js'

/**
 * Answers an agent that has stopped for permission.
 *
 * Goes straight to the local runner rather than through the cloud: whoever is
 * at a terminal on this machine should not need the control plane to be
 * reachable to unblock an agent running on it.
 */
export async function runApprove(
  context: CliContext,
  options: ApproveCommandOptions
): Promise<void> {
  const apiBase = await context.resolveDefaultApiBase()

  await postJson(`${apiBase}/runs/${options.runId}/approval`, { choice: options.choice }).catch(
    (error: unknown) => {
      if (error instanceof Error && error.message.includes('Could not reach')) {
        throw runnerUnreachable(apiBase)
      }
      throw error
    }
  )

  const what =
    options.choice === APPROVAL_CHOICE.DENY
      ? chalk.red(`Denied ${options.runId}.`)
      : chalk.green(`Approved ${options.runId} (${options.choice}).`)
  console.log(what)
  console.log(chalk.dim(`  sentinel0 logs --run ${options.runId} --follow    watch it continue`))
}
