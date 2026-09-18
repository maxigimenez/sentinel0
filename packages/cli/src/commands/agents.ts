import chalk from 'chalk'
import type { AgentDescriptor } from '@sentinel0/common'
import { getJson, runnerUnreachable } from '../api.js'
import type { CliContext } from '../types.js'

export async function runAgents(context: CliContext): Promise<void> {
  const apiBase = await context.resolveDefaultApiBase()

  const { agents } = await getJson<{ agents: AgentDescriptor[] }>(`${apiBase}/agents`).catch(() => {
    throw runnerUnreachable(apiBase)
  })

  if (agents.length === 0) {
    console.log(chalk.yellow('No agents discovered.'))
    console.log(chalk.dim('  Check "sentinel0 preflight" — a bad profile key hides that profile.'))
    return
  }

  console.log('')
  for (const agent of agents) {
    const mark = agent.enabled ? chalk.green('*') : chalk.dim('-')
    console.log(
      `  ${mark} ${chalk.bold(agent.profile)}${agent.role ? chalk.dim(`  ${agent.role}`) : ''}`
    )
    console.log(chalk.dim(`      model      ${agent.model ?? 'unknown'}`))
    if (agent.githubLogin) {
      console.log(chalk.dim(`      github     ${agent.githubLogin}`))
    }
    if (agent.linearUserId) {
      console.log(
        chalk.dim(`      linear     ${agent.linearUserId} (workspace ${agent.linearWorkspaceId})`)
      )
    }
    if (agent.toolsets.length) {
      console.log(chalk.dim(`      toolsets   ${agent.toolsets.join(', ')}`))
    }
    if (agent.skills.length) {
      console.log(
        chalk.dim(
          `      skills     ${agent.skills.slice(0, 6).join(', ')}${agent.skills.length > 6 ? ', …' : ''}`
        )
      )
    }
  }
  console.log('')
}
