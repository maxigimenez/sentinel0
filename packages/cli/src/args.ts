import path from 'node:path'
import {
  APPROVAL_CHOICE,
  APPROVAL_CHOICES,
  DEFAULT_API_PORT,
  DEFAULT_CONCURRENCY,
} from '@sentinel0/common'
import type {
  ApproveCommandOptions,
  CancelCommandOptions,
  EmptyOptions,
  LogsCommandOptions,
  RunCommandOptions,
  RunnerCommandOptions,
  RunsCommandOptions,
  StartCommandOptions,
} from './types.js'

/**
 * Strict argument parsing.
 *
 * Every command has one parser, and an unrecognized flag is an error rather
 * than something silently ignored -- a typo'd flag that quietly does nothing is
 * worse than a failed command.
 */

export function resolvePath(raw: string): string {
  return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw)
}

export function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag)
}

function valueOf(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  if (index === -1) {
    return undefined
  }
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value.`)
  }
  return value
}

function assertKnownFlags(args: string[], allowed: string[], command: string): void {
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]
    if (!token.startsWith('--')) {
      continue
    }
    if (!allowed.includes(token)) {
      throw new Error(`Unknown flag "${token}" for "${command}". Allowed: ${allowed.join(', ')}.`)
    }
    // Skip the value so it is not mistaken for a positional argument.
    if (args[i + 1] && !args[i + 1].startsWith('--')) {
      i += 1
    }
  }
}

function parseIntOption(
  raw: string | undefined,
  label: string,
  fallback: number,
  min: number,
  max: number
): number {
  if (raw === undefined) {
    return fallback
  }
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}.`)
  }
  return parsed
}

export function parseStartOptions(args: string[]): StartCommandOptions {
  assertKnownFlags(
    args,
    ['--api-port', '--concurrency', '--network-access', '--foreground'],
    'start'
  )
  return {
    apiPort: parseIntOption(valueOf(args, '--api-port'), '--api-port', DEFAULT_API_PORT, 1, 65535),
    concurrency: parseIntOption(
      valueOf(args, '--concurrency'),
      '--concurrency',
      DEFAULT_CONCURRENCY,
      1,
      16
    ),
    networkAccess: hasFlag(args, '--network-access'),
    foreground: hasFlag(args, '--foreground'),
  }
}

export function parseLogsOptions(args: string[]): LogsCommandOptions {
  assertKnownFlags(args, ['--run', '--follow'], 'logs')
  return { runId: valueOf(args, '--run'), follow: hasFlag(args, '--follow') }
}

export function parseRunsOptions(args: string[]): RunsCommandOptions {
  assertKnownFlags(args, ['--status', '--limit'], 'runs')
  return {
    status: valueOf(args, '--status'),
    limit: parseIntOption(valueOf(args, '--limit'), '--limit', 20, 1, 200),
  }
}

export function parseRunOptions(args: string[]): RunCommandOptions {
  assertKnownFlags(args, ['--agent', '--prompt', '--timeout'], 'run')
  const agent = valueOf(args, '--agent')
  const prompt = valueOf(args, '--prompt')
  if (!agent) {
    throw new Error('run requires --agent <profile>.')
  }
  if (!prompt) {
    throw new Error('run requires --prompt "<text>".')
  }
  return {
    agent,
    prompt,
    timeoutSeconds: parseIntOption(valueOf(args, '--timeout'), '--timeout', 600, 5, 7200),
  }
}

export function parseCancelOptions(args: string[]): CancelCommandOptions {
  const runId = args.find((arg) => !arg.startsWith('--'))
  if (!runId) {
    throw new Error('cancel requires a run id.')
  }
  return { runId }
}

/**
 * `approve <run-id> [--once|--session|--always|--deny]`
 *
 * Defaults to `session`: the common case is unblocking one agent that has
 * stopped mid-task, and granting only the single call means being asked again
 * moments later. `always` is never the default -- it outlives the run.
 */
export function parseApproveOptions(args: string[]): ApproveCommandOptions {
  assertKnownFlags(args, ['--once', '--session', '--always', '--deny'], 'approve')
  const runId = args.find((arg) => !arg.startsWith('--'))
  if (!runId) {
    throw new Error('approve requires a run id.')
  }

  const chosen = APPROVAL_CHOICES.filter((choice) => args.includes(`--${choice}`))
  if (chosen.length > 1) {
    throw new Error(`approve takes one of: ${APPROVAL_CHOICES.map((c) => `--${c}`).join(', ')}.`)
  }

  return { runId, choice: chosen[0] ?? APPROVAL_CHOICE.SESSION }
}

export function parseRunnerOptions(args: string[]): RunnerCommandOptions {
  const action = args.find((arg) => !arg.startsWith('--'))
  if (action !== 'install' && action !== 'uninstall' && action !== 'status') {
    throw new Error('runner requires one of: install, uninstall, status.')
  }
  return { action }
}

export function parseEmptyOptions(args: string[], command: string): EmptyOptions {
  assertKnownFlags(args, [], command)
  return {}
}
