import fs from 'node:fs'
import path from 'node:path'

import {staticPlugin} from '@elysiajs/static'
import {file} from 'bun'
import {Elysia} from 'elysia'

import {getAppServerRuntimeConfig} from './server/utils/getAppServerRuntimeConfig.ts'
import {exitWithRuntimeLogFlush} from './server/utils/runtimeLogger.ts'

const appServerRuntimeConfig = getAppServerRuntimeConfig()

const resolveDistDir = () => {
  const candidates = [
    appServerRuntimeConfig.distDir,
    '/app/dist',
    path.resolve(process.cwd(), 'dist'),
    path.resolve(import.meta.dir, '../dist'),
  ].filter(Boolean) as string[]

  const pick = (dir: string) => {
    return fs.existsSync(path.join(dir, 'index.html')) && fs.existsSync(path.join(dir, 'assets'))
  }
  const found = candidates.find(pick)
  return found ?? path.resolve(process.cwd(), 'dist')
}

const distDir = resolveDistDir()
const assetsDir = path.join(distDir, 'assets')

export const app = new Elysia()
  .use(staticPlugin({assets: assetsDir, prefix: '/assets'}))
  .all('*', async ({request}) => {
    const url = new URL(request.url)

    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      const target = `${appServerRuntimeConfig.apiScheme}://${appServerRuntimeConfig.apiHost}:${appServerRuntimeConfig.apiPort}${url.pathname}${url.search}`
      const method = request.method
      const body = method === 'GET' || method === 'HEAD' ? undefined : request.body
      return fetch(target, {method, headers: request.headers, body})
    }

    return file(path.join(distDir, 'index.html'))
  })

const listener = app.listen(appServerRuntimeConfig.port)
let shutdownStarted = false

if (listener.server && typeof listener.server === 'object') {
  const {hostname, port: serverPort} = listener.server as {hostname?: string; port?: number}
  console.log(`🦊 App static server running at ${String(hostname ?? 'unknown')}:${String(serverPort ?? 'unknown')}`)
} else {
  console.log(`🦊 App static server started on port ${appServerRuntimeConfig.port}`)
}

;(['SIGINT', 'SIGTERM'] as const).map((signal) => {
  return process.once(signal, () => {
    if (shutdownStarted) {
      return
    }

    shutdownStarted = true
    void app.stop().finally(() => {
      return exitWithRuntimeLogFlush({code: 0})
    })
  })
})

export type App = typeof app
