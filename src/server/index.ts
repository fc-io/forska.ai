import {cors} from '@elysiajs/cors'
import {Elysia} from 'elysia'

import {articlesRoutes} from './routes/ArticlesRoutes.ts'
import {authRoutes} from './routes/AuthRoutes.ts'
import {tokensRoutes} from './routes/TokensRoutes.ts'

const app = new Elysia()
  .use(cors())
  .use(authRoutes)
  .use(articlesRoutes)
  .use(tokensRoutes)
  .listen(3000)

console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`,
)

export type App = typeof app
