import {type} from 'arktype'

import {getDatabase} from '../server/utils/getDatabase'
import {user} from '../../auth-schema'

// Arktype schema for Profile validation
export const profileSchema = type({
  id: 'string',
  name: 'string',
  email: 'string',
  emailVerified: 'boolean',
  image: 'string | null',
  createdAt: 'Date',
  updatedAt: 'Date',
  role: 'string | null',
  banned: 'boolean | null',
  banReason: 'string | null',
  banExpires: 'Date | null',
})

export const profilesArraySchema = profileSchema.array()

export type Profile = typeof profileSchema.infer

export const fetchProfiles = async (): Promise<Profile[]> => {
  try {
    const db = getDatabase()
    const data = await db.select().from(user).orderBy(user.createdAt)

    if (!data) {
      return []
    }

    // Validate response using arktype
    const validation = profilesArraySchema(data)
    if (validation instanceof type.errors) {
      console.error('Profile validation errors:', validation.summary)
      throw new Error(
        `Invalid profile data received from database: ${validation.summary}`,
      )
    }

    return validation
  } catch (err) {
    console.error('Error fetching profiles:', err)
    throw err
  }
}