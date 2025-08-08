import {cors} from '@elysiajs/cors'
import {type Context, Elysia} from 'elysia'

import {auth} from '../auth.ts'

const betterAuthView = (context: Context) => {
  const BETTER_AUTH_ACCEPT_METHODS = ['POST', 'GET']
  // validate request method
  if (BETTER_AUTH_ACCEPT_METHODS.includes(context.request.method)) {
    return auth.handler(context.request)
  } else {
    context.error(405)
  }
}

const app = new Elysia()
  .use(cors())
  .all('/api/auth/*', betterAuthView)
  .listen(3000)

console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`,
)
