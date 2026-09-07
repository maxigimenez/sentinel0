/**
 * The one way this package turns a caught `unknown` into a log line.
 *
 * Extracted from `index.ts` when a second module needed it. Duplicating four
 * lines would have been cheaper to write and is exactly how two subtly
 * different error renderings end up in the same log.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
