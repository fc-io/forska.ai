import type {Context} from 'elysia'

import {deleteProviderConnection, getProviderConnection} from '../../providers/providerConnectionRepository.ts'
import {deleteProviderSecret} from '../../providers/providerSecretStore.ts'

export const providerConnectionsRoutesDeleteConnection = async ({
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
    const result = await deleteProviderConnection(connection.id)

    if (connection.secretRef) {
      await deleteProviderSecret(connection.secretRef).catch((error) => {
        console.warn(
          '[provider-connections] Failed to delete provider secret:',
          error instanceof Error ? error.message : error,
        )
      })
    }

    return {data: result, error: null}
  } catch (error) {
    set.status = 400
    return {data: null, error: error instanceof Error ? error.message : 'Failed to remove provider connection'}
  }
}
