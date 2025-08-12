import {cors} from '@elysiajs/cors'
import {Elysia} from 'elysia'

import {articlesRoutes} from './routes/ArticlesRoutes.ts'
import {authRoutes} from './routes/AuthRoutes.ts'
import {judgablesRoutes} from './routes/JudgablesRoutes.ts'
import {projectsRoutes} from './routes/ProjectsRoutes.ts'
import {tokensRoutes} from './routes/TokensRoutes.ts'
import {usersRoutes} from './routes/UsersRoutes.ts'

const app = new Elysia()
  .use(cors())
  .use(authRoutes)
  .use(articlesRoutes)
  .use(judgablesRoutes)
  .use(projectsRoutes)
  .use(tokensRoutes)
  .use(usersRoutes)
  .listen(3000)

console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`,
)

export type App = typeof app
