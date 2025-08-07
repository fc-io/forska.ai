import 'dotenv/config'

import {defineConfig} from 'drizzle-kit'

export default defineConfig({
  out: './drizzle',
  schema: ['./src/db/schema.ts'],
  //   schema: ['./src/db/schema.ts', './auth-schema.ts'],
  dialect: 'postgresql',
  dbCredentials: {url: process.env.DATABASE_URL!},
  verbose: true,
})
