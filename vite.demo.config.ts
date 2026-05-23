import { defineConfig } from 'vite'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Config for running the demo locally
export default defineConfig({
  root: 'demo',
  resolve: {
    alias: [
      { find: /^rebook\/parsers\/epub$/, replacement: resolve(__dirname, 'src/parsers/epub.ts') },
      { find: /^rebook$/, replacement: resolve(__dirname, 'src/index.ts') },
    ],
  },
  server: {
    port: 3131,
    host: true,
    allowedHosts: ['pi.tailc1b810.ts.net'],
  },
})
