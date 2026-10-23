import type {Context} from 'elysia'

import {getProviderConnection} from '../../providers/providerConnectionRepository.ts'
import {testProviderConnectionHealth} from '../../providers/providerHealthService.ts'

export const providerConnectionsRoutesPostConnectionTest = async ({
  params,
  set,
}: {
  params: {id: string}
  set: Context['set']
}) => {
  const connection = await getProviderConnection(params.id)

  if (!connection) {
    set.status = 404
    return {data: null, error: 'Provider connection not found'}
  }

  try {
    const result = await testProviderConnectionHealth(connection)

    if (!result.ok) {
      set.status = 400
      return {data: null, error: result.message}
    }

    return {data: {message: result.message, modelCount: result.modelCount}, error: null}
  } catch (error) {
    set.status = 400
    return {data: null, error: error instanceof Error ? error.message : 'Provider connection test failed'}
  }
}
