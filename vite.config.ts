import { defineConfig } from 'vite'
import { resolve } from 'path'
import dts from 'vite-plugin-dts'

export default defineConfig({
  plugins: [
    dts({
      include: ['src/**/*.ts'],
      outDir: 'dist',
    }),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
        'parsers/epub': resolve(__dirname, 'src/parsers/epub.ts'),
        'renderers/browser': resolve(__dirname, 'src/renderers/browser/index.ts'),
        'exporters/index': resolve(__dirname, 'src/exporters/index.ts'),
        'exporters/epub': resolve(__dirname, 'src/exporters/epub.ts'),
      },
      formats: ['es'],
    },
    rollupOptions: {
      external: ['@zip.js/zip.js'],
    },
    target: 'es2022',
    minify: false,
  },
})
