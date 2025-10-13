import {staticPlugin} from '@elysiajs/static'
import {file} from 'bun'
import {Elysia} from 'elysia'

const port = Number(process.env.PROD_SERVER || 8080)
const apiPort = Number(process.env.SERVER_PORT || 3000)

const app = new Elysia()
  .use(staticPlugin({assets: 'dist/assets', prefix: '/assets'}))
  .all('/api/*', async ({request}) => {
    const url = new URL(request.url)
    const target = `http://localhost:${apiPort}${url.pathname}${url.search}`
    const method = request.method
    const body = method === 'GET' || method === 'HEAD' ? undefined : (request as Request).body
    return fetch(target, {method, headers: request.headers, body})
  })
  .get('*', () => {
    return file('dist/index.html')
  })
  .listen(port)

console.log(`🦊 App static server running at ${app.server?.hostname}:${app.server?.port}`)

export type App = typeof app
