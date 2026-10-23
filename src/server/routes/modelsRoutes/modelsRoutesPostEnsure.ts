import type {Context} from 'elysia'

import {ensureCodexProviderModel} from '../../providers/ensureCodexProviderModel.ts'
import {normalizeProviderKind} from '../../services/providerCatalog.ts'
import {getTrimmedValue, normalizeDisplayName} from '../providerRoutes/providerRoutesShared.ts'

export const modelsRoutesPostEnsure = async ({
  body,
  set,
}: {
  body: {modelName: string; name: string; provider: string; providerConnectionId?: string; version?: string}
  set: Context['set']
}) => {
  const provider = normalizeProviderKind(body.provider)

  if (provider !== 'codex') {
    set.status = 400
    return {data: null, error: 'Unsupported provider'}
  }

  const modelName = body.modelName.trim()

  if (!modelName) {
    set.status = 400
    return {data: null, error: 'modelName is required'}
  }

  const ensured = await ensureCodexProviderModel({
    modelName,
    name: normalizeDisplayName(body.name),
    providerConnectionId: getTrimmedValue(body.providerConnectionId),
    version: getTrimmedValue(body.version),
  })

  return {data: {modelId: ensured.modelId}, error: null}
}
