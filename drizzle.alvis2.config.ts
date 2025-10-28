import { defineConfig } from 'drizzle-kit';

console.log(process.env.REMOTE_DATABASE_URL);
export default defineConfig({
  dialect: 'postgresql',
//   schema: './src/schema/**/*.ts',
  out: './drizzle',
  dbCredentials: { url: `${process.env.REMOTE_DATABASE_URL}` },
});
