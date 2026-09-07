/**
 * Checks that a clean install of the packed CLI has every package its bundled
 * code imports.
 *
 * `@sentinel0/common` and `@sentinel0/orchestrator` ship inside the tarball as
 * bundleDependencies, and prepare-package.mjs writes each a minimal manifest
 * with no `dependencies`. npm therefore never learns that the orchestrator
 * needs p-limit, fastify and the rest: the install succeeds, and the first
 * `sentinel0 start` on a user's machine dies with ERR_MODULE_NOT_FOUND. That is
 * exactly what shipped in `parallax-cli` 0.2.0, this package under its former
 * name.
 *
 * Presence is checked first, then the subpath. Full resolution on another
 * package's behalf needs a resolver rooted at that package — `import.meta.resolve`
 * takes no parent argument on modern Node and would resolve everything relative
 * to this file — and importing the modules to find out would execute them. So
 * the subpath check reads the target package's own `exports` map, which is the
 * thing Node consults and the thing that was wrong.
 *
 * The subpath half exists because 0.0.3 shipped with `@sentinel0/common`
 * present and `@sentinel0/common/github` unreachable: prepare-package.mjs wrote
 * the bundled manifest a hand-copied `exports` listing two of six subpaths, and
 * a check that collapses "@scope/name/sub" to "@scope/name" sees a directory
 * that is right there. `sentinel0 start` died with ERR_PACKAGE_PATH_NOT_EXPORTED.
 *
 * Run from a directory where the tarball has been npm-installed:
 *   npm init -y && npm install sentinel0-x.y.z.tgz
 *   node verify-bundled-imports.mjs
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { join } from 'node:path'

// Builtins resolve without being installed, and older code imports some of them
// unprefixed ("child_process" rather than "node:child_process").
const BUILTIN = new Set(builtinModules)

const BUNDLE = 'node_modules/sentinel0/node_modules'
const SEARCH = ['node_modules', BUNDLE]

const files = (dir) =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    return statSync(full).isDirectory() ? files(full) : full.endsWith('.js') ? [full] : []
  })

/** "@scope/name/sub" -> "@scope/name"; "p-limit/x" -> "p-limit". */
const packageName = (specifier) => {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

/** The directory a package was installed into, or undefined. */
const packageDir = (name) => SEARCH.map((dir) => join(dir, name)).find((dir) => existsSync(dir))

/**
 * Whether `subpath` ("./github") is reachable in an exports map, by Node's
 * rules: a map with no "./"-style keys exports only the package root, and a
 * key may carry one `*` wildcard.
 */
const exportsSubpath = (exports, subpath) => {
  if (exports === undefined) {
    // No map at all: deep imports are unrestricted, and checking the file would
    // have to reimplement extension and directory-index resolution.
    return true
  }
  const keys = typeof exports === 'object' && exports !== null ? Object.keys(exports) : []
  if (!keys.some((key) => key.startsWith('.'))) {
    return false
  }
  return keys.some((key) => {
    if (!key.includes('*')) {
      return key === subpath
    }
    const [prefix, suffix] = key.split('*')
    return subpath.startsWith(prefix) && subpath.endsWith(suffix ?? '')
  })
}

const missing = new Map()
const unexported = new Map()
for (const scoped of readdirSync(join(BUNDLE, '@sentinel0'))) {
  for (const file of files(join(BUNDLE, '@sentinel0', scoped))) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(
      /(?:^|\s)(?:import|export)[^;]*?from\s+["']([^."'][^"']*)["']/g
    )) {
      const specifier = match[1]
      if (specifier.startsWith('node:')) continue
      const name = packageName(specifier)
      if (BUILTIN.has(name)) continue
      const dir = packageDir(name)
      if (!dir) {
        missing.set(name, file)
        continue
      }

      const subpath = '.' + specifier.slice(name.length)
      if (subpath === '.') {
        continue
      }
      const { exports } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      if (!exportsSubpath(exports, subpath)) {
        unexported.set(specifier, file)
      }
    }
  }
}

let failed = false

if (missing.size > 0) {
  failed = true
  console.error(
    'UNRESOLVED after a clean install:\n  ' +
      [...missing].map(([name, file]) => `${name}  (imported by ${file})`).join('\n  ')
  )
}

if (unexported.size > 0) {
  failed = true
  console.error(
    'PRESENT but not exported — the package is installed and the subpath is not\n' +
      'in its "exports", so importing it fails with ERR_PACKAGE_PATH_NOT_EXPORTED:\n  ' +
      [...unexported].map(([spec, file]) => `${spec}  (imported by ${file})`).join('\n  ')
  )
}

if (failed) {
  process.exit(1)
}
console.log('Every package and subpath the bundled code imports is reachable.')
