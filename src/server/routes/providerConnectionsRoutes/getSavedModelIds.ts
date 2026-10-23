export const getSavedModelIds = (models: Array<{modelName: string | null; remoteModelId: string | null}>): string[] => {
  return models.flatMap((model) => {
    return [model.remoteModelId, model.modelName].filter((value): value is string => {
      return Boolean(value)
    })
  })
}
