import {defineConfig} from 'drizzle-kit'

import {env} from './src/server/utils/env.ts'

export default defineConfig({
  out: './src/db/duckdbMigrations',
  schema: ['./src/db/schema.ts'],
  dialect: 'sqlite',
  dbCredentials: {url: env.DUCKDB_PATH},
  verbose: true,
  strict: false,
})
