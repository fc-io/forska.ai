import {eq} from 'drizzle-orm'

import {user} from '../../db/schema.ts'
import {localUserDefaults} from '../../utils/localUser.ts'
import {env} from './env.ts'
import {getDatabase} from './getDatabase.ts'

const selectLocalUser = {
  id: user.id,
  name: user.name,
  email: user.email,
  role: user.role,
  openalexMailto: user.openalexMailto,
}

const getBootstrapOpenalexMailto = () => {
  const rawValue = String(env.OPENALEX_MAILTO ?? '').trim()
  return rawValue === '' ? null : rawValue
}

export const ensureLocalUser = async () => {
  const db = getDatabase()
  await db
    .insert(user)
    .values({...localUserDefaults, openalexMailto: getBootstrapOpenalexMailto()})
    .onConflictDoNothing({target: user.id})

  const [row] = await db.select(selectLocalUser).from(user).where(eq(user.id, localUserDefaults.id)).limit(1)
  return row ?? localUserDefaults
}

export const getLocalUser = async () => {
  return ensureLocalUser()
}
