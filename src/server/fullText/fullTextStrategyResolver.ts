import {fullTextStrategyErrorMessages} from '../../utils/fullTextStrategyOptions.ts'
import {
  FULL_TEXT_PROMPT_LAYOUT_VERSION,
  FULL_TEXT_TOKENIZER_ID,
  type FullTextChunkPolicy,
  type FullTextFigureMode,
  type FullTextStrategy,
  type FullTextStrategyInputs,
  getFullTextStrategy,
} from './fullTextStrategy.ts'

export type FullTextConversionModelStrategyInputs = {
  converterKind: FullTextStrategyInputs['converterKind']
  converterOptionsHash: string
  converterVersion: string | null
  modelLabel: string
}

export type FullTextStrategyEnvironment = {
  canonicalTextVersion: string | null
  conversionModel: FullTextConversionModelStrategyInputs | null
  imageTokenEstimateVersion: string | null
  imageTransportVersion: string | null
}

export type FullTextStrategySelection = {chunkPolicy: FullTextChunkPolicy | null; figureMode: FullTextFigureMode | null}

export type FullTextStrategyResolution = {errors: string[]; strategy: FullTextStrategy | null}

export {fullTextStrategyErrorMessages}

const getConverterVersionMissingMessage = (modelLabel: string) => {
  return `PDF-to-text model ${modelLabel} has not reported a server version. Refresh its provider's models on the Models page and select the discovered model in Settings → PDF conversion.`
}

const getFullTextStrategyErrors = (selection: FullTextStrategySelection, environment: FullTextStrategyEnvironment) => {
  return [
    environment.conversionModel ? null : fullTextStrategyErrorMessages.conversionModelMissing,
    environment.conversionModel && environment.conversionModel.converterVersion === null
      ? getConverterVersionMissingMessage(environment.conversionModel.modelLabel)
      : null,
    environment.canonicalTextVersion ? null : fullTextStrategyErrorMessages.canonicalTextVersionMissing,
    selection.figureMode ? null : fullTextStrategyErrorMessages.figureModeMissing,
    selection.chunkPolicy ? null : fullTextStrategyErrorMessages.chunkPolicyMissing,
    selection.figureMode === 'native_images' && !environment.imageTransportVersion
      ? fullTextStrategyErrorMessages.imageTransportMissing
      : null,
    selection.figureMode === 'native_images' && !environment.imageTokenEstimateVersion
      ? fullTextStrategyErrorMessages.imageTokenEstimateMissing
      : null,
  ].filter((error): error is string => {
    return error !== null
  })
}

const getFullTextStrategyInputs = ({
  chunkPolicy,
  conversionModel,
  environment,
  figureMode,
}: {
  chunkPolicy: FullTextChunkPolicy
  conversionModel: FullTextConversionModelStrategyInputs & {converterVersion: string}
  environment: FullTextStrategyEnvironment & {canonicalTextVersion: string}
  figureMode: FullTextFigureMode
}): FullTextStrategyInputs => {
  return {
    canonicalTextVersion: environment.canonicalTextVersion,
    chunkPolicy,
    converterKind: conversionModel.converterKind,
    converterOptionsHash: conversionModel.converterOptionsHash,
    converterVersion: conversionModel.converterVersion,
    figureMode,
    ...(figureMode === 'native_images' && environment.imageTokenEstimateVersion
      ? {imageTokenEstimateVersion: environment.imageTokenEstimateVersion}
      : {}),
    imageTransportVersion: figureMode === 'native_images' ? environment.imageTransportVersion : null,
    promptLayoutVersion: FULL_TEXT_PROMPT_LAYOUT_VERSION,
    tokenizerId: FULL_TEXT_TOKENIZER_ID,
  }
}

export const resolveFullTextStrategy = (
  selection: FullTextStrategySelection,
  environment: FullTextStrategyEnvironment,
): FullTextStrategyResolution => {
  const errors = getFullTextStrategyErrors(selection, environment)
  const conversionModel = environment.conversionModel
  const canonicalTextVersion = environment.canonicalTextVersion

  return errors.length === 0
    && selection.chunkPolicy
    && selection.figureMode
    && conversionModel?.converterVersion
    && canonicalTextVersion
    ? {
        errors,
        strategy: getFullTextStrategy(
          getFullTextStrategyInputs({
            chunkPolicy: selection.chunkPolicy,
            conversionModel: {...conversionModel, converterVersion: conversionModel.converterVersion},
            environment: {...environment, canonicalTextVersion},
            figureMode: selection.figureMode,
          }),
        ),
      }
    : {errors, strategy: null}
}
