import type { ApprovalChoice, StoredConfig } from '@sentinel0/common'

export type RunningState = {
  startedAt: number
  runnerPid: number
  apiPort: number
  networkAccess?: boolean
}

export type VerifyCheck = {
  name: string
  ok: boolean
  required: boolean
  detail?: string
}

export type StartCommandOptions = {
  apiPort: number
  concurrency: number
  networkAccess: boolean
  foreground: boolean
}

export type LogsCommandOptions = { runId?: string; follow: boolean }
export type RunsCommandOptions = { status?: string; limit: number }
export type RunCommandOptions = { agent: string; prompt: string; timeoutSeconds: number }
export type CancelCommandOptions = { runId: string }
export type ApproveCommandOptions = { runId: string; choice: ApprovalChoice }
export type RunnerCommandOptions = { action: 'install' | 'uninstall' | 'status' }
export type EmptyOptions = Record<string, never>

export type CliContext = {
  defaultApiBase: string
  defaultDataDir: string
  manifestFile: string
  rootDir: string
  cliVersion: string
  packageVersion: string
  resolvePath: (raw: string) => string
  ensureFileExists: (filePath: string) => Promise<boolean>
  loadRunningState: () => Promise<RunningState>
  loadStoredConfig: () => Promise<StoredConfig>
  saveStoredConfig: (config: StoredConfig) => Promise<void>
  resolveDefaultApiBase: () => Promise<string>
  buildEnvConfig: (
    dataDir: string,
    runtime: { apiPort: number; concurrency: number; networkAccess: boolean }
  ) => Record<string, string>
}
