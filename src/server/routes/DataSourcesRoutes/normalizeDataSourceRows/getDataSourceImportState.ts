import type {DataSourceImportState} from '../dataSourcesRoutesTypes.ts'
import {getSafeCovidencePackageConfig, getSafeStructuredFileImportConfig} from '../safeDataSourceImportConfigs.ts'

export const getDataSourceImportState = (params: {
  covidenceProjectIdByImportRoute: Map<string, string>
  covidencePromptIdsByImportRoute: Map<string, string[]>
  importRoute: string | null
  cursor: string | null
}): DataSourceImportState => {
  const structuredFileConfig = getSafeStructuredFileImportConfig(params.cursor)
  const covidencePackageConfig = getSafeCovidencePackageConfig(params.cursor)
  const linkedProjectId =
    covidencePackageConfig && params.importRoute
      ? (params.covidenceProjectIdByImportRoute.get(params.importRoute) ?? null)
      : null
  const linkedPromptIds =
    covidencePackageConfig && params.importRoute
      ? (params.covidencePromptIdsByImportRoute.get(params.importRoute) ?? [])
      : []

  return {
    covidencePackageConfig,
    immutable: Boolean(structuredFileConfig || covidencePackageConfig),
    linkedProjectId,
    linkedPromptIds,
    reimportable: Boolean(covidencePackageConfig),
    structuredFileConfig,
  }
}
