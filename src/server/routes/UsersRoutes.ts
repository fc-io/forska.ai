import {Elysia} from 'elysia'

import {user} from '../../../auth-schema'
import {getDatabase} from '../utils/getDatabase.ts'

export const usersRoutes = new Elysia().get('/api/users', async () => {
  try {
    const db = getDatabase()
    const users = await db.select().from(user).orderBy(user.createdAt)
    return {data: users}
  } catch (error) {
    console.error('Error fetching users:', error)
    return {data: [], error: 'Failed to fetch users'}
  }
})
