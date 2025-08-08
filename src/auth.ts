import {betterAuth} from 'better-auth'
import {drizzleAdapter} from 'better-auth/adapters/drizzle'

// import {Pool} from 'pg'
import {getDatabase} from './server/utils/getDatabase'
const db = getDatabase()

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: 'pg',
    forceAllowId: process.env.NODE_ENV === 'development' || process.env.SEED === 'true',
  }),
  emailAndPassword: {enabled: true},
  trustedOrigins: ['http://localhost:5173', 'http://localhost:3000'],
  //   socialProviders: {
  //     google: {
  //       clientId: process.env.GOOGLE_CLIENT_ID!,
  //       clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
  //     },
  //   },
})
