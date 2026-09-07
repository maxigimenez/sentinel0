import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// @ts-expect-error — the pack script is plain .mjs with no type declarations.
import { bundledManifest, unresolvableExports } from '../scripts/prepare-package.mjs'

const ROOT = join(process.cwd(), '..', '..')
const BUNDLED = ['packages/common', 'packages/orchestrator']

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
}

function manifest(relative: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(ROOT, relative, 'package.json'), 'utf8'))
}

/**
 * What the tarball says a bundled package exports must be what the package
 * exports.
 *
 * `prepare-package.mjs` writes each bundled package a manifest of its own,
 * because the workspace one carries `workspace:*` ranges npm cannot resolve.
 * That manifest used to be a hand-written literal — a second copy of `exports`
 * that nothing compared against the first. `@sentinel0/common` grew `./github`
 * and three more subpaths; the literal still listed `.` and `./executor`, and
 * 0.0.3 shipped a CLI whose `sentinel0 start` died immediately with
 * ERR_PACKAGE_PATH_NOT_EXPORTED for `@sentinel0/common/github`.
 *
 * It could not be caught in the workspace: pnpm links the package by symlink,
 * so every local import resolves against the real manifest and the literal is
 * only consulted inside a published tarball.
 */
describe('bundled manifests', () => {
  it.each(BUNDLED)('carries %s exports verbatim', (relative) => {
    const source = manifest(relative)
    const bundled = bundledManifest(source)

    expect(bundled.exports).toEqual(source.exports)
    expect(bundled.main).toEqual(source.main)
    expect(bundled.types).toEqual(source.types)
    expect(bundled.name).toEqual(source.name)
    expect(bundled.version).toEqual(source.version)
    expect(bundled.type).toEqual('module')
  })

  it.each(BUNDLED)('drops what %s uses only to develop itself', (relative) => {
    const bundled = bundledManifest(manifest(relative))

    // `dependencies` is the load-bearing one: `workspace:*` is unresolvable
    // outside pnpm, and the third-party ranges are declared by the host CLI
    // instead — see bundled-dependencies.test.ts.
    expect(bundled).not.toHaveProperty('dependencies')
    expect(bundled).not.toHaveProperty('devDependencies')
    expect(bundled).not.toHaveProperty('scripts')
    expect(bundled).not.toHaveProperty('private')
    expect(bundled).not.toHaveProperty('files')
  })

  it.each(BUNDLED)('names only files %s actually builds', (relative) => {
    // Requires a build, which CI runs before the tests for exactly this kind
    // of check. An entry pointing at a module tsc never emitted fails the same
    // way the drift above did, just with ERR_MODULE_NOT_FOUND.
    const packageDir = join(ROOT, relative)
    expect(unresolvableExports(bundledManifest(manifest(relative)), packageDir)).toEqual([])
  })

  it('exports every subpath the workspace imports from @sentinel0/common', () => {
    // The other cases keep the tarball honest about the manifest. This one
    // keeps the manifest honest about the code: a new `@sentinel0/common/x`
    // import resolves in the workspace whether or not `exports` names it,
    // because TypeScript's path alias and pnpm's symlink both bypass it.
    const declared = new Set(Object.keys(manifest('packages/common').exports as object))
    const missing = new Set<string>()

    for (const relative of ['packages/cli', 'packages/orchestrator', 'packages/cloud-api']) {
      for (const file of sourceFiles(join(ROOT, relative, 'src'))) {
        const text = readFileSync(file, 'utf8')
        for (const [, subpath] of text.matchAll(/@sentinel0\/common(\/[a-z0-9-]+)/g)) {
          if (!declared.has('.' + subpath)) {
            missing.add(`@sentinel0/common${subpath} (imported by ${relative})`)
          }
        }
      }
    }

    expect([...missing]).toEqual([])
  })
})
