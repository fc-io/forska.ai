import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import {getUserConfigQueryService} from '../services/userConfigQueryService.ts'
import {CANONICAL_TEXT_VERSION} from './canonicalFullText.ts'
import {getConverterOptionsHash} from './converters/converterOptionsHash.ts'
import {getFullTextConverter} from './converters/fullTextConverter.ts'
import {FIGURE_DESCRIPTION_PROMPT_VERSION} from './figureDescriptions.ts'
import {
  type FullTextConversionModelStrategyInputs,
  type FullTextStrategyEnvironment,
} from './fullTextStrategyResolver.ts'

type ConversionModelVersionRow = {modelLabel: string | null; serverVersion: string | null}

const isFullTextStrategyConverterKind = (
  providerKind: string,
): providerKind is FullTextConversionModelStrategyInputs['converterKind'] => {
  return providerKind === 'mineru' || providerKind === 'docling'
}

const getConversionModelVersionRow = async (modelId: string) => {
  const [row] = await getAppDatabaseService().queryJson<ConversionModelVersionRow>(`
    SELECT
      COALESCE(m.display_name, m.remote_model_id, m.name) AS modelLabel,
      NULLIF(TRIM(json_extract_string(m.metadata_json, '$.converter.serverVersion')), '') AS serverVersion
    FROM app.model m
    WHERE m.id = ${getSqlLiteral(modelId)}
    LIMIT 1
  `)

  return row ?? null
}

export const getFullTextConversionModelStrategyInputs =
  async (): Promise<FullTextConversionModelStrategyInputs | null> => {
    const config = await getUserConfigQueryService().getFullTextConversionModelConfig()
    const providerKind = config?.providerKind ?? null
    const versionRow = config ? await getConversionModelVersionRow(config.modelId) : null

    return config && providerKind && isFullTextStrategyConverterKind(providerKind)
      ? {
          converterKind: providerKind,
          converterOptionsHash: getConverterOptionsHash(getFullTextConverter(providerKind).options),
          converterVersion: versionRow?.serverVersion ?? null,
          modelLabel: versionRow?.modelLabel ?? config.modelName,
        }
      : null
  }

export const getFigureDescriptionStrategyInputs = async (): Promise<
  FullTextStrategyEnvironment['figureDescription']
> => {
  const config = await getUserConfigQueryService().getFigureDescriptionModelConfig()

  return config ? {modelId: config.modelId, promptVersion: FIGURE_DESCRIPTION_PROMPT_VERSION} : null
}

export const getFullTextStrategyEnvironment = async (): Promise<FullTextStrategyEnvironment> => {
  return {
    canonicalTextVersion: CANONICAL_TEXT_VERSION,
    conversionModel: await getFullTextConversionModelStrategyInputs(),
    figureDescription: await getFigureDescriptionStrategyInputs(),
    imageTransportVersion: null,
  }
}
