import {getConverterOptionsHash} from './converters/converterOptionsHash.ts'
import {getFullTextConverter} from './converters/fullTextConverter.ts'
import {
  FULL_TEXT_PROMPT_LAYOUT_VERSION,
  FULL_TEXT_TOKENIZER_ID,
  type FullTextChunkPolicy,
  type FullTextStrategyInputs,
} from './fullTextStrategy.ts'

export type FullTextStrategyRegistryEntry = {
  firstSeen: string
  id: string
  inputs: FullTextStrategyInputs
  label: string
}

export const fullTextStrategyReferenceConverterVersions = {
  docling:
    'docling=2.140.0 docling-core=2.101.1 docling-ibm-models=4.0.3 docling-jobkit=3.8.2 docling-parse=7.22.3 docling-serve=1.37.0',
  mineru: '4.0.12',
} as const satisfies Record<FullTextStrategyInputs['converterKind'], string>

export const fullTextStrategyRegistry: FullTextStrategyRegistryEntry[] = []

const shippedChunkPolicies: FullTextChunkPolicy[] = [
  {maxPromptTokens: 24_000, mode: 'single_only'},
  {maxPromptTokens: 24_000, mode: 'chunked'},
  {maxPromptTokens: 48_000, mode: 'single_only'},
  {maxPromptTokens: 48_000, mode: 'chunked'},
  {maxPromptTokens: 96_000, mode: 'single_only'},
  {maxPromptTokens: 96_000, mode: 'chunked'},
]

const shippedConverterKinds: Array<FullTextStrategyInputs['converterKind']> = ['mineru', 'docling']

const getShippedConverterInputs = (canonicalTextVersion: string) => {
  return shippedConverterKinds.flatMap((converterKind) => {
    return shippedChunkPolicies.map((chunkPolicy): FullTextStrategyInputs => {
      return {
        canonicalTextVersion,
        chunkPolicy,
        converterKind,
        converterOptionsHash: getConverterOptionsHash(getFullTextConverter(converterKind).options),
        converterVersion: fullTextStrategyReferenceConverterVersions[converterKind],
        figureDescriptionModelId: null,
        figureDescriptionPromptVersion: null,
        figureMode: 'none',
        imageTransportVersion: null,
        promptLayoutVersion: FULL_TEXT_PROMPT_LAYOUT_VERSION,
        tokenizerId: FULL_TEXT_TOKENIZER_ID,
      }
    })
  })
}

export const getShippedFullTextStrategyInputs = (canonicalTextVersion: string | null): FullTextStrategyInputs[] => {
  return canonicalTextVersion === null ? [] : getShippedConverterInputs(canonicalTextVersion)
}
