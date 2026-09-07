import fs from 'node:fs/promises'
import { lstatSync, readlinkSync, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const cliDir = path.resolve(__dirname, '..')
const workspaceRoot = path.resolve(cliDir, '..', '..')
const backupPath = path.join(cliDir, '.pack-backup.json')
const cliPackageJsonPath = path.join(cliDir, 'package.json')

export const bundledPackages = [
  {
    name: '@sentinel0/common',
    sourceDir: path.join(workspaceRoot, 'packages/common'),
  },
  {
    name: '@sentinel0/orchestrator',
    sourceDir: path.join(workspaceRoot, 'packages/orchestrator'),
  },
]

/**
 * The fields a bundled package keeps, and the reason each list is what it is.
 *
 * `dependencies` goes because they are `workspace:*` ranges npm cannot resolve
 * and third-party ranges the host declares instead — see
 * `assertBundledDependenciesAreDeclared`. `private`, `scripts`, `files` and
 * `devDependencies` describe developing the package, not consuming it.
 */
const PUBLISHED_FIELDS = ['name', 'version', 'type', 'main', 'types', 'exports', 'bin']

/**
 * Builds a bundled package's manifest **from the workspace manifest**.
 *
 * This used to be a literal written out here, a second copy of `exports` that
 * nothing compared against the first. `@sentinel0/common` grew `./github`,
 * `./prompt-catalog`, `./route-catalog` and `./route-validation`; this file
 * still listed `.` and `./executor`, so 0.0.3 published an orchestrator whose
 * very first import of `@sentinel0/common/github` died with
 * ERR_PACKAGE_PATH_NOT_EXPORTED on a user's machine and worked perfectly in
 * the workspace, where pnpm's symlink resolves against the real manifest.
 *
 * Deriving it makes that class of drift unrepresentable: a subpath the package
 * exports is a subpath the tarball exports.
 */
export function bundledManifest(source) {
  const manifest = {}
  for (const field of PUBLISHED_FIELDS) {
    if (source[field] !== undefined) {
      manifest[field] = source[field]
    }
  }
  return manifest
}

/**
 * Refuses to pack a manifest that promises a file the build did not produce.
 *
 * The derivation above can only be as honest as `exports` is, and an entry
 * pointing at a module `tsc` never emitted fails identically to the drift it
 * replaced — at import time, on a user's machine.
 */
export function unresolvableExports(manifest, packageDir) {
  const problems = []

  const visit = (subpath, target) => {
    if (typeof target === 'string') {
      if (!existsSync(path.join(packageDir, target))) {
        problems.push(`  ${manifest.name}${subpath.slice(1)} → ${target} (not built)`)
      }
      return
    }
    if (target && typeof target === 'object') {
      for (const value of Object.values(target)) {
        visit(subpath, value)
      }
    }
  }

  for (const field of ['main', 'types']) {
    if (typeof manifest[field] === 'string') {
      visit(`.#${field}`, manifest[field])
    }
  }
  for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
    visit(subpath, target)
  }

  return problems
}

function runPnpm(args) {
  execFileSync('pnpm', ['--dir', workspaceRoot, ...args], {
    stdio: 'inherit',
    cwd: workspaceRoot,
  })
}

async function copyDirectory(sourceDir, targetDir) {
  await fs.mkdir(path.dirname(targetDir), { recursive: true })
  await fs.cp(sourceDir, targetDir, { recursive: true })
}

function targetDirForPackage(packageName) {
  return path.join(cliDir, 'node_modules', ...packageName.split('/'))
}

async function backupExistingTarget(targetDir) {
  try {
    const stats = lstatSync(targetDir)
    if (stats.isSymbolicLink()) {
      return {
        kind: 'symlink',
        target: readlinkSync(targetDir),
      }
    }

    return { kind: 'directory' }
  } catch {
    return { kind: 'missing' }
  }
}

async function writeBundledPackage(metadata) {
  const targetDir = targetDirForPackage(metadata.name)
  await fs.rm(targetDir, { recursive: true, force: true })
  await fs.mkdir(targetDir, { recursive: true })
  await fs.writeFile(
    path.join(targetDir, 'package.json'),
    JSON.stringify(metadata.packageJson, null, 2)
  )
  await copyDirectory(path.join(metadata.sourceDir, 'dist'), path.join(targetDir, 'dist'))
}

/**
 * Refuses to pack a tarball that would fail on a user's machine.
 *
 * Each bundled package is written a minimal manifest with no `dependencies`, so
 * npm never learns that the orchestrator needs p-limit, fastify and the rest.
 * The host package is the only place they can be declared, and if they are not,
 * the install succeeds and the first `sentinel0 start` dies with
 * ERR_MODULE_NOT_FOUND. That shipped in `parallax-cli` 0.2.0.
 *
 * The same rule is asserted in `test/bundled-dependencies.test.ts`, which runs
 * on every PR. This is the last gate before a tarball is written.
 */
function assertBundledDependenciesAreDeclared(cliPackageJson) {
  const declared = cliPackageJson.dependencies ?? {}
  const problems = []

  for (const metadata of bundledPackages) {
    const source = JSON.parse(readFileSync(path.join(metadata.sourceDir, 'package.json'), 'utf8'))
    for (const [name, range] of Object.entries(source.dependencies ?? {})) {
      if (name.startsWith('@sentinel0/')) {
        continue
      }
      if (!declared[name]) {
        problems.push(`  ${name}@${range} — needed by ${metadata.name}, missing from the cli`)
      } else if (declared[name] !== range) {
        problems.push(`  ${name} — cli declares ${declared[name]}, ${metadata.name} needs ${range}`)
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `packages/cli/package.json must declare every third-party dependency of the\n` +
        `packages it bundles, because a bundled package ships without its own:\n\n` +
        problems.join('\n') +
        `\n\nAdd them to "dependencies" in packages/cli/package.json.`
    )
  }
}

function assertExportsResolve() {
  const problems = []

  for (const metadata of bundledPackages) {
    problems.push(...unresolvableExports(metadata.packageJson, metadata.sourceDir))
  }

  if (problems.length > 0) {
    throw new Error(
      `a bundled package's "exports" names a file the build did not produce, so\n` +
        `importing it would fail with ERR_MODULE_NOT_FOUND on a user's machine:\n\n` +
        problems.join('\n')
    )
  }
}

async function main() {
  runPnpm(['--filter', '@sentinel0/common', 'build'])
  runPnpm(['--filter', '@sentinel0/orchestrator', 'build'])
  runPnpm(['--filter', 'sentinel0', 'build'])

  for (const metadata of bundledPackages) {
    const source = JSON.parse(readFileSync(path.join(metadata.sourceDir, 'package.json'), 'utf8'))
    metadata.packageJson = bundledManifest(source)
  }

  const cliPackageJson = JSON.parse(await fs.readFile(cliPackageJsonPath, 'utf8'))
  assertBundledDependenciesAreDeclared(cliPackageJson)
  assertExportsResolve()

  const backup = {
    cliPackageJson,
    packages: {},
  }
  for (const metadata of bundledPackages) {
    const targetDir = targetDirForPackage(metadata.name)
    backup.packages[metadata.name] = await backupExistingTarget(targetDir)
    await writeBundledPackage(metadata)
  }

  const rewrittenCliPackageJson = {
    ...cliPackageJson,
    dependencies: {
      ...cliPackageJson.dependencies,
      '@sentinel0/common': bundledPackages[0].packageJson.version,
      '@sentinel0/orchestrator': bundledPackages[1].packageJson.version,
    },
  }
  await fs.writeFile(cliPackageJsonPath, JSON.stringify(rewrittenCliPackageJson, null, 2) + '\n')

  await fs.writeFile(backupPath, JSON.stringify(backup, null, 2))
}

if (process.argv[1] === __filename) {
  await main()
}
