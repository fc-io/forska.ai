import fs from 'node:fs'
import path from 'node:path'

import {staticPlugin} from '@elysiajs/static'
import {file} from 'bun'
import {Elysia} from 'elysia'

const port = Number(process.env.PROD_SERVER || 8080)
const apiHost = process.env.SERVER_HOST || process.env.API_HOST || 'localhost'
const apiPort = Number(process.env.API_SERVER_PORT || 3000)
const apiScheme = process.env.SERVER_SCHEME || 'http'

const resolveDistDir = () => {
  const envDir = process.env.APP_DIST_DIR || process.env.DIST_DIR || process.env.PUBLIC_DIR
  const candidates = [
    envDir,
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

const app = new Elysia()
  .use(staticPlugin({assets: assetsDir, prefix: '/assets'}))
  .all('/api/*', async ({request}) => {
    const url = new URL(request.url)
    const target = `${apiScheme}://${apiHost}:${apiPort}${url.pathname}${url.search}`
    const method = request.method
    const body = method === 'GET' || method === 'HEAD' ? undefined : request.body
    return fetch(target, {method, headers: request.headers, body})
  })
  .get('*', () => {
    return file(path.join(distDir, 'index.html'))
  })

const listener = app.listen(port)

if (listener.server && typeof listener.server === 'object') {
  const {hostname, port: serverPort} = listener.server as {hostname?: string; port?: number}
  console.log(`🦊 App static server running at ${String(hostname ?? 'unknown')}:${String(serverPort ?? 'unknown')}`)
} else {
  console.log(`🦊 App static server started on port ${port}`)
}

export type App = typeof app
