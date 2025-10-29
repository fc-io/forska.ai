import {defineConfig} from 'drizzle-kit'

import {env} from './src/server/utils/env.ts'

export default defineConfig({
  out: './src/db/migrations',
  //   schema: ['./src/db/schema.ts'],
  schema: ['./src/db/schema.ts', './auth-schema.ts'],
  dialect: 'postgresql',
  dbCredentials: {url: env.DATABASE_URL},
  verbose: true,
  strict: true,
})
