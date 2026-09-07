import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      /*
       * Subpaths first. Vite matches a string alias as a prefix, so a bare
       * '@sentinel0/common' listed above these would rewrite
       * '@sentinel0/common/github' into 'index.ts/github'.
       */
      '@sentinel0/common/executor': path.resolve(__dirname, '../common/src/executor.ts'),
      '@sentinel0/common/github': path.resolve(__dirname, '../common/src/github.ts'),
      '@sentinel0/common': path.resolve(__dirname, '../common/src/index.ts'),
    },
  },
})
