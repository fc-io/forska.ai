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

const guardResponse = (sessionUserId: string | null, set: Context['set'], request: Request) => {
  return !sessionUserId ? unauthorized(set, request) : null
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
  return {session, sessionUserId}
}

const createAuthGuard = () => {
  return new Elysia()
    .derive(async ({request}) => {
      console.error('[authGuard] derive called for:', request.url)
      return await getSessionDetails(request)
    })
    .onBeforeHandle(({set, sessionUserId, request}) => {
      return guardResponse(sessionUserId, set, request)
    })
}

export const requireUserAuth = () => {
  return createAuthGuard()
}
