import tailwindcss from '@tailwindcss/vite'
import {tanstackRouter} from '@tanstack/router-plugin/vite'
import path from 'path'
import {defineConfig} from 'vite'
import solid from 'vite-plugin-solid'

import {env} from './src/server/utils/env.ts'

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
  server: {port: env.VITE_PORT, strictPort: false},
  build: {target: 'esnext'},
})
