import 'dotenv/config'

import {cors} from '@elysiajs/cors'
import {drizzle} from 'drizzle-orm/node-postgres'
import {Elysia} from 'elysia'

import {testElysiaTable} from '../db/schema'
import {getDatabase} from './utils/getDatabase.ts'

const db = getDatabase()
// const db = drizzle(process.env.DATABASE_URL!)
// console.log('DATABASE_URL', process.env.DATABASE_URL)

const index = new Elysia().get('/', () => {
  return 'Hello Elysia'
})
const test = new Elysia().get('/test', async () => {
  const users = await db.select().from(testElysiaTable)
  return JSON.stringify(users)
})
const app = new Elysia().use(cors()).use(index).use(test).listen(3000)

export type App = typeof app
console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`,
)

// app.handle(new Request('http://localhost:3000/test')).then(console.log)`
