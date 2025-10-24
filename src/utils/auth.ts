import {betterAuth} from 'better-auth'
import {drizzleAdapter} from 'better-auth/adapters/drizzle'

import {env} from '../server/utils/env.ts'
import {getDatabase} from '../server/utils/getDatabase.ts'

const db = getDatabase()

export const auth = betterAuth({
  database: drizzleAdapter(db, {provider: 'pg'}),
  secret: env.BETTER_AUTH_SECRET,
  emailAndPassword: {enabled: true},
  //   socialProviders: {
  //     google: {
  //       clientId: process.env.GOOGLE_CLIENT_ID!,
  //       clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
  //     },
  //   },
})
