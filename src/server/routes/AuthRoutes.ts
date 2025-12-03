import {type Context, Elysia} from 'elysia'

import {auth} from '../../auth.ts'

const respondMethodNotAllowed = (context: Context) => {
  context.set.status = 405
  return {data: null, error: 'Method not allowed'}
}

const betterAuthView = (context: Context) => {
  const BETTER_AUTH_ACCEPT_METHODS = ['POST', 'GET']
  const isMethodAllowed = BETTER_AUTH_ACCEPT_METHODS.includes(context.request.method)
  return isMethodAllowed ? auth.handler(context.request) : respondMethodNotAllowed(context)
}

export const authRoutes = new Elysia().all('/api/auth/*', betterAuthView)
