#!/usr/bin/env node
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import chalk from 'chalk'
import { DEFAULT_API_PORT } from '@sentinel0/common'
import {
  parseApproveOptions,
  parseCancelOptions,
  parseEmptyOptions,
  parseLogsOptions,
  parseRunOptions,
  parseRunnerOptions,
  parseRunsOptions,
  parseStartOptions,
  resolvePath,
} from './args.js'
import {
  ensureFileExists,
  loadRunningState as loadRunningStateFromDisk,
  loadStoredConfig as loadStoredConfigFromDisk,
  resolveCliRoot,
  saveStoredConfig as saveStoredConfigToDisk,
} from './config.js'
import { MANIFEST_FILE } from './constants.js'
import { ensureCapableRuntime, SQLITE_FLAG } from './node-runtime.js'
import { runAgents } from './commands/agents.js'
import { runCancel } from './commands/cancel.js'
import { runApprove } from './commands/approve.js'
import { runInit } from './commands/init.js'
import { runLogs } from './commands/logs.js'
import { runPreflight } from './commands/preflight.js'
import { runProjects } from './commands/projects.js'
import { runReload } from './commands/reload.js'
import { runRestart } from './commands/restart.js'
import { runRoutes } from './commands/routes.js'
import { runRunner } from './commands/runner.js'
import { runRuns } from './commands/runs.js'
import { runSmokeTest } from './commands/run.js'
import { runStart } from './commands/start.js'
import { runStatus } from './commands/status.js'
import { runStop } from './commands/stop.js'
import type { CliContext } from './types.js'
import { printUsage } from './usage.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const DEFAULT_DATA_DIR = process.env.SENTINEL0_DATA_DIR
  ? path.resolve(process.env.SENTINEL0_DATA_DIR)
  : path.join(os.homedir(), '.sentinel0')
const DEFAULT_API_BASE = `http://localhost:${DEFAULT_API_PORT}`
const ROOT_DIR = resolveCliRoot(__dirname)

function resolvePackageVersion(rootDir: string): string {
  const candidates = [
    path.resolve(rootDir, 'packages/cli/package.json'),
    path.resolve(rootDir, 'package.json'),
    path.resolve(__dirname, '../package.json'),
    path.resolve(__dirname, '../../package.json'),
  ]
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) {
      continue
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { version?: string }
      if (parsed.version) {
        return parsed.version
      }
    } catch {
      continue
    }
  }
  return '0.0.0'
}

const PACKAGE_VERSION = resolvePackageVersion(ROOT_DIR)

// Before anything else: if this interpreter cannot load node:sqlite, hand off to
// one that can. Doing it here means every command benefits, and a version switch
// after install produces a re-exec rather than a failure deep in the database.
try {
  ensureCapableRuntime(DEFAULT_DATA_DIR, __filename)
} catch (error: unknown) {
  console.error(chalk.red(error instanceof Error ? error.message : String(error)))
  process.exit(1)
}

const context: CliContext = {
  defaultApiBase: DEFAULT_API_BASE,
  defaultDataDir: DEFAULT_DATA_DIR,
  manifestFile: MANIFEST_FILE,
  rootDir: ROOT_DIR,
  cliVersion: PACKAGE_VERSION,
  packageVersion: PACKAGE_VERSION,
  resolvePath,
  ensureFileExists,
  loadRunningState: () => loadRunningStateFromDisk(DEFAULT_DATA_DIR, MANIFEST_FILE),
  loadStoredConfig: () => loadStoredConfigFromDisk(DEFAULT_DATA_DIR),
  saveStoredConfig: (config) => saveStoredConfigToDisk(DEFAULT_DATA_DIR, config),

  // Commands that talk to a running runner read the port it actually bound,
  // rather than assuming the default -- otherwise a non-default --api-port
  // silently breaks every read command.
  resolveDefaultApiBase: async () => {
    try {
      const running = await loadRunningStateFromDisk(DEFAULT_DATA_DIR, MANIFEST_FILE)
      return `http://localhost:${running.apiPort}`
    } catch {
      return DEFAULT_API_BASE
    }
  },

  buildEnvConfig: (dataDir, runtime) => ({
    // node:sqlite needs the flag on Node 22 and ignores it from 23 on, so one
    // invocation covers every supported runtime; the warning is suppressed
    // because it fires on every boot and says nothing actionable.
    NODE_OPTIONS:
      `${process.env.NODE_OPTIONS ?? ''} ${SQLITE_FLAG} --disable-warning=ExperimentalWarning`.trim(),
    SENTINEL0_DATA_DIR: dataDir,
    SENTINEL0_DB_PATH: path.join(dataDir, 'sentinel0.db'),
    SENTINEL0_SERVER_API_PORT: String(runtime.apiPort),
    SENTINEL0_CONCURRENCY: String(runtime.concurrency),
    SENTINEL0_NETWORK_ACCESS: String(runtime.networkAccess),
    SENTINEL0_VERSION: PACKAGE_VERSION,
  }),
}

async function dispatch(command: string | undefined, args: string[]): Promise<void> {
  switch (command) {
    case 'init':
      return runInit(context)
    case 'preflight':
      return runPreflight(context)
    case 'start':
      return runStart(context, parseStartOptions(args))
    case 'stop':
      parseEmptyOptions(args, 'stop')
      return runStop(context)
    case 'restart':
      return runRestart(context, parseStartOptions(args))
    case 'status':
      parseEmptyOptions(args, 'status')
      return runStatus(context)
    case 'runner':
      return runRunner(context, parseRunnerOptions(args))
    case 'projects':
      parseEmptyOptions(args, 'projects')
      return runProjects(context)
    case 'reload':
      parseEmptyOptions(args, 'reload')
      return runReload(context)
    case 'agents':
      parseEmptyOptions(args, 'agents')
      return runAgents(context)
    case 'routes':
      parseEmptyOptions(args, 'routes')
      return runRoutes(context)
    case 'runs':
      return runRuns(context, parseRunsOptions(args))
    case 'logs':
      return runLogs(context, parseLogsOptions(args))
    case 'cancel':
      return runCancel(context, parseCancelOptions(args))
    case 'approve':
      return runApprove(context, parseApproveOptions(args))
    case 'run':
      return runSmokeTest(context, parseRunOptions(args))
    case 'version':
    case '--version':
    case '-v':
      console.log(PACKAGE_VERSION)
      return
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      printUsage(PACKAGE_VERSION)
      return
    default:
      throw new Error(`Unknown command "${command}". Run "sentinel0 help".`)
  }
}

dispatch(process.argv[2], process.argv.slice(3)).catch((error: unknown) => {
  console.error(chalk.red(error instanceof Error ? error.message : String(error)))
  process.exitCode = 1
})
