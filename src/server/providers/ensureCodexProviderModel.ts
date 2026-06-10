import {getProviderModelThinkingOption} from '../../utils/providerModelOptions.ts'
import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import {
  createProviderConnection,
  getFirstEnabledProviderConnection,
  updateProviderConnection,
} from './providerConnectionRepository.ts'
import {getManualProviderModelMetadata} from './providerModelMetadata.ts'
import {createProviderModel, updateProviderModel} from './providerModelRepository.ts'

const getTrimmedValue = (value: string | null | undefined) => {
  const normalized = String(value ?? '').trim()

  return normalized === '' ? null : normalized
}

const getCodexDisplayName = (value: string) => {
  return value.trim() === '' ? 'Codex model' : value.trim()
}

const getCodexConnectionForEnsure = async () => {
  const existing = await getFirstEnabledProviderConnection('codex')

  if (existing) {
    return existing
  }

  const connection = await createProviderConnection({
    authMode: 'codex-cli',
    baseURL: null,
    config: {manualWorkerUrls: [], workerUrlMode: 'manual'},
    label: 'Codex',
    maxInflightRequests: null,
    providerKind: 'codex',
    secretRef: null,
  })

  return connection.enabled
    ? connection
    : updateProviderConnection({
        authMode: connection.authMode,
        baseURL: connection.baseURL,
        config: connection.config,
        enabled: true,
        id: connection.id,
        label: connection.label,
        maxInflightRequests: connection.maxInflightRequests,
        secretRef: connection.secretRef,
      })
}

export const ensureCodexProviderModel = async ({
  modelName,
  name,
  version,
}: {
  modelName: string
  name: string
  version?: string | null
}) => {
  const normalizedModelName = getTrimmedValue(modelName)

  if (normalizedModelName === null) {
    throw new Error('modelName is required')
  }

  const normalizedVersion = getTrimmedValue(version)
  const displayName = getCodexDisplayName(name)
  const connection = await getCodexConnectionForEnsure()
  const thinking = normalizedVersion ? getProviderModelThinkingOption(normalizedVersion) : null
  const [existing] = await getAppDatabaseService().queryJson<{id: string}>(`
    SELECT id
    FROM app.model
    WHERE provider_connection_id = ${getSqlLiteral(connection.id)}
      AND remote_model_id = ${getSqlLiteral(normalizedModelName)}
      AND ${normalizedVersion ? `variant = ${getSqlLiteral(normalizedVersion)}` : 'variant IS NULL'}
    LIMIT 1
  `)

  if (existing) {
    const model = await updateProviderModel({
      displayName,
      enabled: true,
      id: existing.id,
      options: {thinking},
      variant: normalizedVersion,
    })

    return {modelId: model.id, providerConnectionId: connection.id}
  }

  const model = await createProviderModel({
    connection,
    displayName,
    metadataJson: getManualProviderModelMetadata({
      displayName,
      modelName: normalizedModelName,
      options: {thinking},
      providerKind: connection.providerKind,
      remoteModelId: normalizedModelName,
      variant: normalizedVersion,
      version: normalizedVersion,
    }),
    modelName: normalizedModelName,
    remoteModelId: normalizedModelName,
    source: 'manual',
    variant: normalizedVersion,
    version: normalizedVersion,
  })

  return {modelId: model.id, providerConnectionId: connection.id}
}
