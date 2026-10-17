import {CANONICAL_TEXT_VERSION} from './canonicalFullText.ts'
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

export const fullTextStrategyRegistry: FullTextStrategyRegistryEntry[] = [
  {
    firstSeen: '2026-10-17',
    id: 'fts-559b78bebcf5845f',
    inputs: {
      canonicalTextVersion: 'canonical-v1',
      chunkPolicy: {maxPromptTokens: 24_000, mode: 'single_only'},
      converterKind: 'mineru',
      converterOptionsHash: 'e9d85ef6fe205701cea9cf7f29abcc18f3ba884041b2f392facf5262be7ffb96',
      converterVersion: '4.0.12',
      figureDescriptionModelId: null,
      figureDescriptionPromptVersion: null,
      figureMode: 'none',
      imageTransportVersion: null,
      promptLayoutVersion: 'layout-v1',
      tokenizerId: 'o200k_base',
    },
    label: 'mineru 4.0.12 / none / single 24k',
  },
  {
    firstSeen: '2026-10-17',
    id: 'fts-fb6b539cb2072d9a',
    inputs: {
      canonicalTextVersion: 'canonical-v1',
      chunkPolicy: {maxPromptTokens: 24_000, mode: 'chunked'},
      converterKind: 'mineru',
      converterOptionsHash: 'e9d85ef6fe205701cea9cf7f29abcc18f3ba884041b2f392facf5262be7ffb96',
      converterVersion: '4.0.12',
      figureDescriptionModelId: null,
      figureDescriptionPromptVersion: null,
      figureMode: 'none',
      imageTransportVersion: null,
      promptLayoutVersion: 'layout-v1',
      tokenizerId: 'o200k_base',
    },
    label: 'mineru 4.0.12 / none / chunked 24k',
  },
  {
    firstSeen: '2026-10-17',
    id: 'fts-5460128812886ed3',
    inputs: {
      canonicalTextVersion: 'canonical-v1',
      chunkPolicy: {maxPromptTokens: 48_000, mode: 'single_only'},
      converterKind: 'mineru',
      converterOptionsHash: 'e9d85ef6fe205701cea9cf7f29abcc18f3ba884041b2f392facf5262be7ffb96',
      converterVersion: '4.0.12',
      figureDescriptionModelId: null,
      figureDescriptionPromptVersion: null,
      figureMode: 'none',
      imageTransportVersion: null,
      promptLayoutVersion: 'layout-v1',
      tokenizerId: 'o200k_base',
    },
    label: 'mineru 4.0.12 / none / single 48k',
  },
  {
    firstSeen: '2026-10-17',
    id: 'fts-6f53f27c2d9e3af7',
    inputs: {
      canonicalTextVersion: 'canonical-v1',
      chunkPolicy: {maxPromptTokens: 48_000, mode: 'chunked'},
      converterKind: 'mineru',
      converterOptionsHash: 'e9d85ef6fe205701cea9cf7f29abcc18f3ba884041b2f392facf5262be7ffb96',
      converterVersion: '4.0.12',
      figureDescriptionModelId: null,
      figureDescriptionPromptVersion: null,
      figureMode: 'none',
      imageTransportVersion: null,
      promptLayoutVersion: 'layout-v1',
      tokenizerId: 'o200k_base',
    },
    label: 'mineru 4.0.12 / none / chunked 48k',
  },
  {
    firstSeen: '2026-10-17',
    id: 'fts-4ee6fa2f186c5678',
    inputs: {
      canonicalTextVersion: 'canonical-v1',
      chunkPolicy: {maxPromptTokens: 96_000, mode: 'single_only'},
      converterKind: 'mineru',
      converterOptionsHash: 'e9d85ef6fe205701cea9cf7f29abcc18f3ba884041b2f392facf5262be7ffb96',
      converterVersion: '4.0.12',
      figureDescriptionModelId: null,
      figureDescriptionPromptVersion: null,
      figureMode: 'none',
      imageTransportVersion: null,
      promptLayoutVersion: 'layout-v1',
      tokenizerId: 'o200k_base',
    },
    label: 'mineru 4.0.12 / none / single 96k',
  },
  {
    firstSeen: '2026-10-17',
    id: 'fts-13370bcf7a40e879',
    inputs: {
      canonicalTextVersion: 'canonical-v1',
      chunkPolicy: {maxPromptTokens: 96_000, mode: 'chunked'},
      converterKind: 'mineru',
      converterOptionsHash: 'e9d85ef6fe205701cea9cf7f29abcc18f3ba884041b2f392facf5262be7ffb96',
      converterVersion: '4.0.12',
      figureDescriptionModelId: null,
      figureDescriptionPromptVersion: null,
      figureMode: 'none',
      imageTransportVersion: null,
      promptLayoutVersion: 'layout-v1',
      tokenizerId: 'o200k_base',
    },
    label: 'mineru 4.0.12 / none / chunked 96k',
  },
  {
    firstSeen: '2026-10-17',
    id: 'fts-a9ce16f7880cdac4',
    inputs: {
      canonicalTextVersion: 'canonical-v1',
      chunkPolicy: {maxPromptTokens: 24_000, mode: 'single_only'},
      converterKind: 'docling',
      converterOptionsHash: '586cab5f8f4f27c9346faf409e31f8b6867e1af612c3bb824aacb5a9a6417bf0',
      converterVersion:
        'docling=2.140.0 docling-core=2.101.1 docling-ibm-models=4.0.3 docling-jobkit=3.8.2 docling-parse=7.22.3 docling-serve=1.37.0',
      figureDescriptionModelId: null,
      figureDescriptionPromptVersion: null,
      figureMode: 'none',
      imageTransportVersion: null,
      promptLayoutVersion: 'layout-v1',
      tokenizerId: 'o200k_base',
    },
    label: 'docling 1.37.0 / none / single 24k',
  },
  {
    firstSeen: '2026-10-17',
    id: 'fts-dc139acb0d78e234',
    inputs: {
      canonicalTextVersion: 'canonical-v1',
      chunkPolicy: {maxPromptTokens: 24_000, mode: 'chunked'},
      converterKind: 'docling',
      converterOptionsHash: '586cab5f8f4f27c9346faf409e31f8b6867e1af612c3bb824aacb5a9a6417bf0',
      converterVersion:
        'docling=2.140.0 docling-core=2.101.1 docling-ibm-models=4.0.3 docling-jobkit=3.8.2 docling-parse=7.22.3 docling-serve=1.37.0',
      figureDescriptionModelId: null,
      figureDescriptionPromptVersion: null,
      figureMode: 'none',
      imageTransportVersion: null,
      promptLayoutVersion: 'layout-v1',
      tokenizerId: 'o200k_base',
    },
    label: 'docling 1.37.0 / none / chunked 24k',
  },
  {
    firstSeen: '2026-10-17',
    id: 'fts-1d74c973a4180044',
    inputs: {
      canonicalTextVersion: 'canonical-v1',
      chunkPolicy: {maxPromptTokens: 48_000, mode: 'single_only'},
      converterKind: 'docling',
      converterOptionsHash: '586cab5f8f4f27c9346faf409e31f8b6867e1af612c3bb824aacb5a9a6417bf0',
      converterVersion:
        'docling=2.140.0 docling-core=2.101.1 docling-ibm-models=4.0.3 docling-jobkit=3.8.2 docling-parse=7.22.3 docling-serve=1.37.0',
      figureDescriptionModelId: null,
      figureDescriptionPromptVersion: null,
      figureMode: 'none',
      imageTransportVersion: null,
      promptLayoutVersion: 'layout-v1',
      tokenizerId: 'o200k_base',
    },
    label: 'docling 1.37.0 / none / single 48k',
  },
  {
    firstSeen: '2026-10-17',
    id: 'fts-4e0da9f1a5be8fb9',
    inputs: {
      canonicalTextVersion: 'canonical-v1',
      chunkPolicy: {maxPromptTokens: 48_000, mode: 'chunked'},
      converterKind: 'docling',
      converterOptionsHash: '586cab5f8f4f27c9346faf409e31f8b6867e1af612c3bb824aacb5a9a6417bf0',
      converterVersion:
        'docling=2.140.0 docling-core=2.101.1 docling-ibm-models=4.0.3 docling-jobkit=3.8.2 docling-parse=7.22.3 docling-serve=1.37.0',
      figureDescriptionModelId: null,
      figureDescriptionPromptVersion: null,
      figureMode: 'none',
      imageTransportVersion: null,
      promptLayoutVersion: 'layout-v1',
      tokenizerId: 'o200k_base',
    },
    label: 'docling 1.37.0 / none / chunked 48k',
  },
  {
    firstSeen: '2026-10-17',
    id: 'fts-28ea5216579b1a3e',
    inputs: {
      canonicalTextVersion: 'canonical-v1',
      chunkPolicy: {maxPromptTokens: 96_000, mode: 'single_only'},
      converterKind: 'docling',
      converterOptionsHash: '586cab5f8f4f27c9346faf409e31f8b6867e1af612c3bb824aacb5a9a6417bf0',
      converterVersion:
        'docling=2.140.0 docling-core=2.101.1 docling-ibm-models=4.0.3 docling-jobkit=3.8.2 docling-parse=7.22.3 docling-serve=1.37.0',
      figureDescriptionModelId: null,
      figureDescriptionPromptVersion: null,
      figureMode: 'none',
      imageTransportVersion: null,
      promptLayoutVersion: 'layout-v1',
      tokenizerId: 'o200k_base',
    },
    label: 'docling 1.37.0 / none / single 96k',
  },
  {
    firstSeen: '2026-10-17',
    id: 'fts-56d24ad6c695cd46',
    inputs: {
      canonicalTextVersion: 'canonical-v1',
      chunkPolicy: {maxPromptTokens: 96_000, mode: 'chunked'},
      converterKind: 'docling',
      converterOptionsHash: '586cab5f8f4f27c9346faf409e31f8b6867e1af612c3bb824aacb5a9a6417bf0',
      converterVersion:
        'docling=2.140.0 docling-core=2.101.1 docling-ibm-models=4.0.3 docling-jobkit=3.8.2 docling-parse=7.22.3 docling-serve=1.37.0',
      figureDescriptionModelId: null,
      figureDescriptionPromptVersion: null,
      figureMode: 'none',
      imageTransportVersion: null,
      promptLayoutVersion: 'layout-v1',
      tokenizerId: 'o200k_base',
    },
    label: 'docling 1.37.0 / none / chunked 96k',
  },
]

const shippedChunkPolicies: FullTextChunkPolicy[] = [
  {maxPromptTokens: 24_000, mode: 'single_only'},
  {maxPromptTokens: 24_000, mode: 'chunked'},
  {maxPromptTokens: 48_000, mode: 'single_only'},
  {maxPromptTokens: 48_000, mode: 'chunked'},
  {maxPromptTokens: 96_000, mode: 'single_only'},
  {maxPromptTokens: 96_000, mode: 'chunked'},
]

const shippedConverterKinds: Array<FullTextStrategyInputs['converterKind']> = ['mineru', 'docling']

export const getShippedFullTextStrategyInputs = (): FullTextStrategyInputs[] => {
  return shippedConverterKinds.flatMap((converterKind) => {
    return shippedChunkPolicies.map((chunkPolicy): FullTextStrategyInputs => {
      return {
        canonicalTextVersion: CANONICAL_TEXT_VERSION,
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
