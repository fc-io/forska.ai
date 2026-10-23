import {toCodexVirtualId} from './toCodexVirtualId.ts'

export const getSelectableCodexModel = ({
  createdAt,
  displayName,
  modelName,
  providerConnectionId,
  updatedAt,
  version,
}: {
  createdAt: Date | null
  displayName: string
  modelName: string
  providerConnectionId: string | null
  updatedAt: Date | null
  version: string | null
}) => {
  return {
    apiKeyVariable: null,
    baseURL: null,
    createdAt,
    id: toCodexVirtualId(modelName, version),
    label: `Codex: ${displayName}`,
    modelName,
    name: displayName,
    provider: 'codex',
    providerConnectionId,
    updatedAt,
    version,
    workerUrls: null,
  }
}
