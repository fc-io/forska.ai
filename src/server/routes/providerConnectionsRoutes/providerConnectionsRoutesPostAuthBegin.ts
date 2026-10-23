import type {Context} from 'elysia'

import {beginProviderAuth, getProviderAuthConnection} from '../../providers/providerAuthService.ts'
import {normalizeProviderKind} from '../../services/providerCatalog.ts'
import {getPublicProviderConnection} from '../providerRoutes/providerRoutesShared.ts'

export const providerConnectionsRoutesPostAuthBegin = async ({
  body,
  params,
  set,
}: {
  body: {connectionId?: string}
  params: {providerKind: string}
  set: Context['set']
}) => {
  const providerKind = normalizeProviderKind(params.providerKind)

  if (providerKind === 'unknown') {
    set.status = 400
    return {data: null, error: 'Unsupported provider'}
  }

  const connection = await getProviderAuthConnection(body.connectionId ?? null)
  const result = await beginProviderAuth({connection, providerKind})

  return {
    data: {result: {...result, connection: result.connection ? getPublicProviderConnection(result.connection) : null}},
    error: null,
  }
}
