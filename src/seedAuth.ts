import {drizzle} from 'drizzle-orm/node-postgres'

import * as authSchema from '../auth-schema.ts'
import {getDatabaseUrl} from './db/getDatabaseUrl.ts'

const db = drizzle(getDatabaseUrl(), {schema: authSchema, logger: false})

const seedAuthData = async () => {
  console.log('🗑️  Clearing existing auth data...')
  await db.delete(authSchema.account)
  await db.delete(authSchema.session)
  await db.delete(authSchema.verification)
  await db.delete(authSchema.user)

  console.log('🌱 Seeding auth data...')

  const users = [
    {
      id: 'user_1',
      name: 'John Doe',
      email: 'john@example.com',
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: 'user_2',
      name: 'Jane Smith',
      email: 'jane@example.com',
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: 'user_3',
      name: 'Bob Johnson',
      email: 'bob@example.com',
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ]

  console.log('Creating users...')
  for (const user of users) {
    await db.insert(authSchema.user).values(user)
  }

  console.log('Creating sessions...')
  const sessions = [
    {
      id: 'session_1',
      userId: 'user_1',
      token: 'token_1',
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: 'session_2',
      userId: 'user_2',
      token: 'token_2',
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ]

  for (const session of sessions) {
    await db.insert(authSchema.session).values(session)
  }

  console.log('✅ Auth data seeded successfully')
  console.log(`  - ${users.length} users created`)
  console.log(`  - ${sessions.length} sessions created`)
  process.exit(0)
}

seedAuthData().catch((err) => {
  console.error('❌ Error seeding auth data:', err)
  process.exit(1)
})
