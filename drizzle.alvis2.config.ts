import {defineConfig} from 'drizzle-kit'

console.log(process.env.REMOTE_DATABASE_URL)
export default defineConfig({
  dialect: 'postgresql',
  //   schema: './src/schema/**/*.ts',
  schema: ['./src/db/schema.ts'],
  out: './src/db/migrations',
  strict: false,
  dbCredentials: {url: `${process.env.REMOTE_DATABASE_URL}`},
})
