import tailwindcss from '@tailwindcss/vite'
import {tanstackRouter} from '@tanstack/router-plugin/vite'
import {defineConfig} from 'vite'
import solid from 'vite-plugin-solid'

import {env} from './src/server/utils/env.ts'

// eslint-disable-next-line import/no-default-export
export default defineConfig({
  plugins: [
    solid(),
    tanstackRouter({
      target: 'solid',
      autoCodeSplitting: true,
      routesDirectory: './src/app/routes',
      generatedRouteTree: './src/app/routeTree.gen.ts',
    }),
    tailwindcss(),
  ],
  server: {
    port: env.VITE_PORT,
    strictPort: false,
    proxy: {
      '/api/arxiv': {
        target: 'https://oaipmh.arxiv.org',
        changeOrigin: true,
        rewrite: (path) => {
          return path.replace(/^\/api\/arxiv/, '')
        },
        secure: true,
      },
      '/api': {
        target: `http://localhost:${env.SERVER_PORT}`,
        changeOrigin: true,
      },
    },
  },
  build: {target: 'esnext'},
})
