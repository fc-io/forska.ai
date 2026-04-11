import path from 'path'

import tailwindcss from '@tailwindcss/vite'
import {tanstackRouter} from '@tanstack/router-plugin/vite'
import {defineConfig} from 'vite'
import solid from 'vite-plugin-solid'

import {env} from './src/server/utils/env.ts'
import {getAppServerRuntimeConfig} from './src/server/utils/getAppServerRuntimeConfig.ts'

const appServerRuntimeConfig = getAppServerRuntimeConfig()
const apiProxyTarget = `${appServerRuntimeConfig.apiScheme}://${appServerRuntimeConfig.apiHost}:${appServerRuntimeConfig.apiPort}`

// eslint-disable-next-line import/no-default-export
export default defineConfig({
  plugins: [
    tanstackRouter({
      target: 'solid',
      autoCodeSplitting: true,
      routesDirectory: './src/app/routes',
      routeFilePrefix: '+',
      generatedRouteTree: './src/app/routeTree.gen.ts',
    }),
    solid(),
    tailwindcss(),
  ],
  resolve: {alias: {'~': path.resolve(__dirname, './src')}},
  server: {port: env.VITE_PORT, strictPort: false, proxy: {'/api': {target: apiProxyTarget, changeOrigin: true}}},
  build: {target: 'esnext'},
  test: {environment: 'happy-dom', include: ['src/**/*.vitest.ts', 'src/**/*.vitest.tsx']},
})
