import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
//   schema: './src/schema/**/*.ts',
  out: './drizzle',
  dbCredentials: { url: `postgresql://${process.env.DB_USER}:${process.env.DB_PASS}@localhost:5432/${process.env.DB_NAME}` },
});
