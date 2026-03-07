import {eq} from 'drizzle-orm'
import {Elysia} from 'elysia'

import {user} from '../../../auth-schema'
import {localUserEmail, localUserId, localUserName} from '../../utils/localUser.ts'
import {getDatabase} from './getDatabase.ts'

const localUserCache = {value: null as {id: string; name: string; email: string} | null}

const loadLocalUserFromDb = async (): Promise<{id: string; name: string; email: string}> => {
  const db = getDatabase()
  await db.insert(user).values({id: localUserId, name: localUserName, email: localUserEmail}).onConflictDoNothing()

  const selection = {id: user.id, name: user.name, email: user.email}
  const [row] = await db.select(selection).from(user).where(eq(user.id, localUserId)).limit(1)
  return row ?? {id: localUserId, name: localUserName, email: localUserEmail}
}

const ensureLocalUser = async (): Promise<{id: string; name: string; email: string}> => {
  const value = localUserCache.value ?? (await loadLocalUserFromDb())
  localUserCache.value = value
  return value
}

const getSessionDetails = async (_request: Request) => {
  const assumedUser = await ensureLocalUser()
  const session = {user: assumedUser, session: {userId: assumedUser.id}}
  return {session, sessionUserId: assumedUser.id}
}

const createAuthGuard = () => {
  return new Elysia().derive(async ({request}) => {
    return await getSessionDetails(request)
  })
}

export const requireUserAuth = () => {
  return createAuthGuard()
}
