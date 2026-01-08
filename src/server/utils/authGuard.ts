import {type Context, Elysia} from 'elysia'

import {auth} from '../../auth.ts'

const hasAuthCookie = (request: Request) => {
  const cookieHeader = request.headers.get('cookie') ?? ''
  return (
    cookieHeader.includes('better-auth.session_token=') || cookieHeader.includes('__Secure-better-auth.session_token=')
  )
}

const unauthorized = (set: Context['set'], request: Request) => {
  set.status = 401
  return {data: null, error: 'You must be signed in', meta: {hasAuthCookie: hasAuthCookie(request)}}
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
  request: Request,
) => {
  return !sessionUserId ? unauthorized(set, request) : requireAdmin && role !== 'admin' ? forbidden(set) : null
}

const getSessionDetails = async (request: Request) => {
  const cookieHeader = request.headers.get('cookie')
  console.error('[authGuard] Cookie header present:', !!cookieHeader)
  if (cookieHeader) {
    console.error('[authGuard] Cookie preview:', cookieHeader.slice(0, 100))
  }
  const session = await auth.api.getSession({headers: request.headers})
  console.error('[authGuard] Session result:', session ? 'found' : 'null', session?.user?.id ?? 'no-user-id')
  const sessionUserId = session?.user?.id ?? session?.session?.userId ?? null
  const role = session?.user?.role ?? null
  return {session, sessionUserId, role}
}

const createAuthGuard = (requireAdmin: boolean) => {
  return new Elysia()
    .derive(async ({request}) => {
      console.error('[authGuard] derive called for:', request.url)
      return await getSessionDetails(request)
    })
    .onBeforeHandle(({set, sessionUserId, role, request}) => {
      return guardResponse(sessionUserId, role, requireAdmin, set, request)
    })
}

export const requireUserAuth = () => {
  return createAuthGuard(false)
}

export const requireAdminAuth = () => {
  return createAuthGuard(true)
}
