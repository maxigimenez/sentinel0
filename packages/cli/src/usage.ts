import chalk from 'chalk'

const BRAND = chalk.hex('#f97316')

export function printUsage(version: string): void {
  console.log(
    [
      '',
      `  ${BRAND('sentinel0')} ${chalk.dim(version)}`,
      chalk.dim('  Triggers Hermes agents from your tickets and pull requests.'),
      '',
      chalk.bold('  Setup'),
      '    init                        connect this machine to the cloud and to Hermes',
      '    preflight                   check everything this runner needs',
      '',
      chalk.bold('  Running'),
      '    start [--foreground]        start the runner',
      '    stop                        stop it',
      '    restart                     stop and start again',
      '    status                      is it up, and what does it see',
      '    reload                      re-pull projects, routes and agents now',
      '    runner install|uninstall|status',
      chalk.dim('                                keep it running across reboots (launchd)'),
      '',
      chalk.bold('  Inspecting'),
      '    projects                    ticket sources it is polling',
      '    agents                      Hermes profiles this runner discovered',
      '    routes                      routing rules it is dispatching on',
      '    runs [--status] [--limit]   recent runs',
      '    logs [--run <id>] [--follow]',
      '    cancel <run-id>             stop a run, on this side and on Hermes',
      '    approve <run-id> [--deny]   answer an agent waiting for permission',
      '',
      chalk.bold('  Debugging'),
      '    run --agent <profile> --prompt "..."',
      chalk.dim('                                send one prompt straight to Hermes'),
      '',
      chalk.bold('  Flags for start'),
      '    --api-port <n>              default 9371',
      '    --concurrency <n>           default 2, max 16',
      '    --network-access            expose the runner API to your LAN',
      '    --foreground                run in this terminal instead of detaching',
      '',
    ].join('\n')
  )
}
