import {
  deleteProviderSecretValue,
  getProviderSecretValue,
  storeProviderSecretValue,
} from '../services/providerSecretStore.ts'

export const readProviderSecret = async (secretRef: string | null | undefined): Promise<string | null> => {
  return getProviderSecretValue(secretRef)
}

export const storeProviderSecret = async ({
  connectionId,
  secret,
}: {
  connectionId: string
  secret: string
}): Promise<string> => {
  return storeProviderSecretValue({connectionId, secret})
}

export const deleteProviderSecret = async (secretRef: string | null | undefined): Promise<void> => {
  return deleteProviderSecretValue(secretRef)
}

export const getProviderSecretStore = () => {
  return {delete: deleteProviderSecret, read: readProviderSecret, store: storeProviderSecret}
}
