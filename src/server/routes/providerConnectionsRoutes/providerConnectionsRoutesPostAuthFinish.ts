import type {Context, Static, t} from 'elysia'

import {finishProviderAuth, getProviderAuthConnection} from '../../providers/providerAuthService.ts'
import type {ProviderAuthLifecyclePayload} from '../../providers/providerTypes.ts'
import {normalizeProviderKind} from '../../services/providerCatalog.ts'
import {getPublicProviderConnection} from '../providerRoutes/providerRoutesShared.ts'

export const providerConnectionsRoutesPostAuthFinish = async ({
  body,
  params,
  set,
}: {
  body: {connectionId?: string; payload?: Static<ReturnType<typeof t.Any>>}
  params: {providerKind: string}
  set: Context['set']
}) => {
  const providerKind = normalizeProviderKind(params.providerKind)

  if (providerKind === 'unknown') {
    set.status = 400
    return {data: null, error: 'Unsupported provider'}
  }

  const connection = await getProviderAuthConnection(body.connectionId ?? null)
  const payload = (body.payload ?? null) as ProviderAuthLifecyclePayload | null
  const result = await finishProviderAuth({connection, payload, providerKind})

  return {
    data: {result: {...result, connection: result.connection ? getPublicProviderConnection(result.connection) : null}},
    error: null,
  }
}
