import 'dotenv/config'

import {cors} from '@elysiajs/cors'
// import {drizzle} from 'drizzle-orm/node-postgres'
import {Context, Elysia} from 'elysia'

import {auth} from '../auth'
// import {testElysiaTable} from '../db/schema'
// import {getDatabase} from './utils/getDatabase.ts'
// const db = getDatabase()
// const db = drizzle(process.env.DATABASE_URL!)
// console.log('DATABASE_URL', process.env.DATABASE_URL)

// const index = new Elysia().get('/', () => {
//   return 'Hello Elysia'
// })
// const test = new Elysia().get('/test', async () => {
//   const users = await db.select().from(testElysiaTable)
//   return JSON.stringify(users)
// })
// const app = new Elysia()
//   .mount(auth.handler)
//   // .use(cors())
//   // .use(index)
//   // .use(test)
//   .listen(3000)

// export type App = typeof app
// console.log(
//   `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`,
// )

// app.handle(new Request('http://localhost:3000/test')).then(console.log)`

const betterAuthView = async (context: Context) => {
  const BETTER_AUTH_ACCEPT_METHODS = ['POST', 'GET']
  // validate request method
  console.log('context.request.method', context.request.method)
  if (BETTER_AUTH_ACCEPT_METHODS.includes(context.request.method)) {
    console.log('path 1', context.request)
    const t = await auth.handler(context.request)
    console.log('t', t)
    return t
  } else {
    console.log('path 2')
    context.error(405)
  }
}

const app = new Elysia().all('/api/auth/*', betterAuthView).listen(3000)

console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`,
)
