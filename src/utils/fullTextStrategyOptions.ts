export const FULL_TEXT_STRATEGY_NONE = 'fts-none'

export const FULL_TEXT_STRATEGY_LEGACY = 'fts-legacy-v0'

export const fullTextConverterKinds = ['mineru', 'docling'] as const

export const fullTextFigureModes = ['none', 'descriptions', 'native_images'] as const

export const fullTextChunkMaxPromptTokens = [24_000, 48_000, 96_000] as const

export const fullTextChunkModes = ['single_only', 'chunked'] as const

export type FullTextStrategyConverterKind = (typeof fullTextConverterKinds)[number]

export type FullTextFigureMode = (typeof fullTextFigureModes)[number]

export type FullTextChunkMaxPromptTokens = (typeof fullTextChunkMaxPromptTokens)[number]

export type FullTextChunkMode = (typeof fullTextChunkModes)[number]

export type FullTextChunkPolicy = {maxPromptTokens: FullTextChunkMaxPromptTokens; mode: FullTextChunkMode}

export type FullTextStrategyInputs = {
  canonicalTextVersion: string
  chunkPolicy: FullTextChunkPolicy
  converterKind: FullTextStrategyConverterKind
  converterOptionsHash: string
  converterVersion: string
  figureDescriptionModelId: string | null
  figureDescriptionPromptVersion: string | null
  figureMode: FullTextFigureMode
  imageTransportVersion: string | null
  promptLayoutVersion: string
  tokenizerId: string
}

export type FullTextStrategy = {id: string; inputs: FullTextStrategyInputs; label: string}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export const getSortedJsonValue = (value: unknown): unknown => {
  return Array.isArray(value)
    ? value.map(getSortedJsonValue)
    : isRecord(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => {
              return [key, getSortedJsonValue(value[key])]
            }),
        )
      : value
}

const figureModeLabels: Record<FullTextFigureMode, string> = {
  descriptions: 'descriptions',
  native_images: 'native images',
  none: 'none',
}

const chunkModeLabels: Record<FullTextChunkMode, string> = {chunked: 'chunked', single_only: 'single'}

const getDoclingServeVersion = (converterVersion: string): string => {
  const serveVersion = converterVersion
    .split(/[\s,]+/)
    .map((part) => {
      return part.split('=')
    })
    .find(([name]) => {
      return name === 'docling-serve'
    })?.[1]

  return serveVersion ?? converterVersion
}

const getConverterVersionLabel = (inputs: FullTextStrategyInputs): string => {
  return inputs.converterKind === 'docling' ? getDoclingServeVersion(inputs.converterVersion) : inputs.converterVersion
}

export const getFullTextChunkPolicyLabel = (chunkPolicy: FullTextChunkPolicy): string => {
  return `${chunkModeLabels[chunkPolicy.mode]} ${chunkPolicy.maxPromptTokens / 1000}k`
}

export const getFullTextFigureModeLabel = (figureMode: FullTextFigureMode): string => {
  return figureModeLabels[figureMode]
}

export const getFullTextStrategyLabel = (inputs: FullTextStrategyInputs): string => {
  return [
    `${inputs.converterKind} ${getConverterVersionLabel(inputs)}`,
    getFullTextFigureModeLabel(inputs.figureMode),
    getFullTextChunkPolicyLabel(inputs.chunkPolicy),
  ].join(' / ')
}

export const isFullTextFigureMode = (value: unknown): value is FullTextFigureMode => {
  return typeof value === 'string' && (fullTextFigureModes as readonly string[]).includes(value)
}

const isFullTextChunkMaxPromptTokens = (value: unknown): value is FullTextChunkMaxPromptTokens => {
  return typeof value === 'number' && (fullTextChunkMaxPromptTokens as readonly number[]).includes(value)
}

const isFullTextChunkMode = (value: unknown): value is FullTextChunkMode => {
  return typeof value === 'string' && (fullTextChunkModes as readonly string[]).includes(value)
}

const getParsedJsonValue = (value: unknown): unknown => {
  return typeof value === 'string' ? JSON.parse(value) : value
}

export const getFullTextChunkPolicy = (value: unknown): FullTextChunkPolicy | null => {
  const parsed = getParsedJsonValue(value)

  return isRecord(parsed) && isFullTextChunkMaxPromptTokens(parsed.maxPromptTokens) && isFullTextChunkMode(parsed.mode)
    ? {maxPromptTokens: parsed.maxPromptTokens, mode: parsed.mode}
    : null
}

export const getLegacyFullTextStrategyId = ({
  useFulltext,
  useFulltextNoImages,
}: {
  useFulltext: boolean
  useFulltextNoImages: boolean
}): string => {
  return useFulltext || useFulltextNoImages ? FULL_TEXT_STRATEGY_LEGACY : FULL_TEXT_STRATEGY_NONE
}

export const getEffectiveFullTextStrategyId = (value: string | null | undefined): string => {
  return value ?? FULL_TEXT_STRATEGY_NONE
}

const reservedFullTextStrategyLabels: Record<string, string> = {
  [FULL_TEXT_STRATEGY_LEGACY]: 'legacy full text (before strategy tracking)',
  [FULL_TEXT_STRATEGY_NONE]: 'no full text',
}

export const getFullTextStrategyDisplayLabel = (id: string, storedLabel: string | null | undefined): string => {
  return reservedFullTextStrategyLabels[id] ?? storedLabel ?? id
}

export const getFullTextStrategyInputDifferences = (
  left: FullTextStrategyInputs,
  right: FullTextStrategyInputs,
): Array<keyof FullTextStrategyInputs> => {
  return (Object.keys(left) as Array<keyof FullTextStrategyInputs>).sort().filter((key) => {
    return JSON.stringify(getSortedJsonValue(left[key])) !== JSON.stringify(getSortedJsonValue(right[key]))
  })
}

const getLegacyFullTextContentLabel = (useFulltextNoImages: boolean) => {
  return useFulltextNoImages ? 'fulltext (legacy, no images)' : 'fulltext (legacy)'
}

const isDerivedFullTextStrategyId = (id: string | null | undefined): id is string => {
  return Boolean(id) && id !== FULL_TEXT_STRATEGY_LEGACY && id !== FULL_TEXT_STRATEGY_NONE
}

export const getProjectFullTextContentLabel = (project: {
  fullTextStrategyId?: string | null
  fullTextStrategyLabel?: string | null
  useFulltext: boolean
  useFulltextNoImages: boolean
}): string | null => {
  const isFullText = project.useFulltext || project.useFulltextNoImages

  return !isFullText
    ? null
    : isDerivedFullTextStrategyId(project.fullTextStrategyId)
      ? `fulltext (${project.fullTextStrategyLabel ?? project.fullTextStrategyId})`
      : getLegacyFullTextContentLabel(project.useFulltextNoImages)
}
