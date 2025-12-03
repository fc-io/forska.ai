import {type Context, Elysia} from 'elysia'

import {auth} from '../../auth.ts'

const unauthorized = (set: Context['set']) => {
  set.status = 401
  return {data: null, error: 'You must be signed in'}
}

const forbidden = (set: Context['set']) => {
  set.status = 403
  return {data: null, error: 'Administrator access required'}
}

const guardResponse = (
  sessionUserId: string | null,
  role: string | null,
  requireAdmin: boolean,
  set: Context['set'],
) => {
  return !sessionUserId ? unauthorized(set) : requireAdmin && role !== 'admin' ? forbidden(set) : null
}

const getSessionDetails = async (request: Request) => {
  const session = await auth.api.getSession({headers: request.headers})
  const sessionUserId = session?.user?.id ?? session?.session?.userId ?? null
  const role = session?.user?.role ?? null
  return {session, sessionUserId, role}
}

const createAuthGuard = (requireAdmin: boolean) => {
  return new Elysia()
    .derive(async ({request}) => {
      return await getSessionDetails(request)
    })
    .onBeforeHandle(({set, sessionUserId, role}) => {
      return guardResponse(sessionUserId, role, requireAdmin, set)
    })
}

export const requireUserAuth = () => {
  return createAuthGuard(false)
}

export const requireAdminAuth = () => {
  return createAuthGuard(true)
}
