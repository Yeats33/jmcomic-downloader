import { resolve } from 'node:path'
import base from '../vite.config.ts'

export default async (environment) => ({
  ...(typeof base === 'function' ? await base(environment) : await base),
  build: {
    outDir: '/tmp/jmcomic-online-prod',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        app: resolve('index.html'),
        onlineFixture: resolve('tests/online-reader.html'),
        workflowsFixture: resolve('tests/workflows.html'),
      },
    },
  },
})
