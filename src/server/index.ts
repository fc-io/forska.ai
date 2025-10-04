import {cors} from '@elysiajs/cors'
import {Elysia} from 'elysia'

import {judgmentsJobsCron} from './cron/judgmentsJobs.ts'
import {articlesRoutes} from './routes/ArticlesRoutes.ts'
import {authRoutes} from './routes/AuthRoutes.ts'
import {dataSourcesImportRoutes} from './routes/DataSourcesImportRoutes.ts'
import {dataSourcesRoutes} from './routes/DataSourcesRoutes.ts'
import {judgmentsJobsRoutes} from './routes/JudgmentsJobsRoutes.ts'
import {judgmentsRoutes} from './routes/JudgmentsRoutes.ts'
import {projectsRoutes} from './routes/ProjectsRoutes.ts'
import {tokensRoutes} from './routes/TokensRoutes.ts'
import {usersRoutes} from './routes/UsersRoutes.ts'
import {vllmStatusRoutes} from './routes/VllmStatusRoutes.ts'
import {env} from './utils/env.ts'

const app = new Elysia()
  .use(cors())
  .use(judgmentsJobsCron)
  .use(authRoutes)
  .use(judgmentsJobsRoutes)
  .use(articlesRoutes)
  .use(judgmentsRoutes)
  .use(projectsRoutes)
  .use(dataSourcesRoutes)
  .use(dataSourcesImportRoutes)
  .use(tokensRoutes)
  .use(usersRoutes)
  .use(vllmStatusRoutes)
  .listen(env.SERVER_PORT)

console.log(`🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`)

export type App = typeof app
