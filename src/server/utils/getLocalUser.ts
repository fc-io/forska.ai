import {eq} from 'drizzle-orm'

import {user} from '../../db/schema.ts'
import {localUserDefaults} from '../../utils/localUser.ts'
import {getDatabase} from './getDatabase.ts'

const selectLocalUser = {id: user.id, name: user.name, email: user.email, role: user.role}

export const ensureLocalUser = async () => {
  const db = getDatabase()
  await db.insert(user).values(localUserDefaults).onConflictDoNothing({target: user.id})

  const [row] = await db.select(selectLocalUser).from(user).where(eq(user.id, localUserDefaults.id)).limit(1)
  return row ?? localUserDefaults
}

export const getLocalUser = async () => {
  return ensureLocalUser()
}
