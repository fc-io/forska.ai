import {defineConfig} from 'drizzle-kit'

import {env} from './src/server/utils/env.ts'

export default defineConfig({
  out: './src/db/sqliteMigrations',
  schema: ['./src/db/schema.ts'],
  dialect: 'sqlite',
  dbCredentials: {url: env.SQLITE_PATH},
  verbose: true,
  strict: false,
})
