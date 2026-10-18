import {expect, test} from 'bun:test'

import {fullTextStrategyErrorMessages} from '../../utils/fullTextStrategyOptions.ts'
import {type FullTextStrategyEnvironment, resolveFullTextStrategy} from '../fullText/fullTextStrategyResolver.ts'
import {type FullTextModelStatusRow, getFullTextModelStatusFromRow} from './fullTextModelStatus.ts'
import {
  evaluateProjectFullTextGate,
  evaluateStoredProjectFullTextGate,
  type ProjectFullTextGateContext,
  type ProjectFullTextGateModel,
  type ProjectFullTextGateSelection,
} from './judgmentJobFullTextGate.ts'

const conversionModel = {
  converterKind: 'mineru' as const,
  converterOptionsHash: 'options-hash',
  converterVersion: '4.0.12',
  modelLabel: 'MinerU standard',
}

const environment: FullTextStrategyEnvironment = {
  canonicalTextVersion: 'canonical-v1',
  conversionModel,
  imageTransportVersion: 'img-v1',
}

const context: ProjectFullTextGateContext = {
  articleFetch: {unpaywallEmailSet: true},
  conversionModelStatus: null,
  environment,
}

const getDiscoveredModel = (inputTokens: number, extraMetadata: Record<string, unknown> = {}) => {
  return {
    metadataJson: {
      discovery: {contextWindow: {inputTokens, outputTokens: null, totalTokens: inputTokens}},
      ...extraMetadata,
    },
    modelName: 'Judge',
    providerKind: 'sglang',
    remoteModelId: 'judge',
  } satisfies ProjectFullTextGateModel
}

const selection: ProjectFullTextGateSelection = {
  fullTextChunkPolicy: {maxPromptTokens: 48_000, mode: 'chunked'},
  fullTextFigureMode: 'none',
  useFulltext: true,
}

const getStatusRow = (overrides: Partial<FullTextModelStatusRow> = {}): FullTextModelStatusRow => {
  return {
    connectionEnabled: true,
    lastCheckedAt: '2026-10-17T20:15:00.000Z',
    lastError: null,
    metadataJson: {converter: {kind: 'mineru', serverVersion: '4.0.12'}},
    modelEnabled: true,
    modelId: 'mineru-model',
    modelLabel: 'MinerU standard',
    providerConfigJson: null,
    providerConnectionId: 'mineru-connection',
    providerKind: 'mineru',
    providerLabel: 'MinerU',
    remoteModelId: 'mineru-standard',
    ...overrides,
  }
}

test('a project without full text passes with no errors or warnings', () => {
  expect(evaluateProjectFullTextGate({context, model: null, selection: {...selection, useFulltext: false}})).toEqual({
    errors: [],
    strategy: null,
    warnings: [],
  })
})

test('full text with a valid model and settings resolves the strategy with no errors', () => {
  const gate = evaluateProjectFullTextGate({context, model: getDiscoveredModel(131_072), selection})

  expect(gate.errors).toEqual([])
  expect(gate.warnings).toEqual([])
  expect(gate.strategy?.label).toBe('mineru 4.0.12 / none / chunked 48k')
})

test('a missing PDF-to-text model is the resolver error pointing at Settings', () => {
  const gate = evaluateProjectFullTextGate({
    context: {...context, environment: {...environment, conversionModel: null}},
    model: getDiscoveredModel(131_072),
    selection,
  })

  expect(gate.errors).toEqual([fullTextStrategyErrorMessages.conversionModelMissing])
  expect(gate.strategy).toBeNull()
})

test('a model without a context window is named with its provider', () => {
  const gate = evaluateProjectFullTextGate({
    context,
    model: {metadataJson: null, modelName: 'Judge', providerKind: 'sglang', remoteModelId: 'judge'},
    selection,
  })

  expect(gate.errors).toEqual(['Model Judge (sglang) has no verified context window. Add it on the Models page.'])
})

test('a context window one token below the prompt size is an error with both numbers', () => {
  const gate = evaluateProjectFullTextGate({context, model: getDiscoveredModel(47_999), selection})

  expect(gate.errors).toEqual([
    "Model Judge (sglang) accepts 47,999 prompt tokens, fewer than the chunk policy's 48,000-token prompt size. Choose a smaller prompt size or another model, or correct its context window on the Models page.",
  ])
})

test('a context window equal to the prompt size passes', () => {
  expect(evaluateProjectFullTextGate({context, model: getDiscoveredModel(48_000), selection}).errors).toEqual([])
})

test('native images needs a model whose image input is verified true', () => {
  const nativeImages = {...selection, fullTextFigureMode: 'native_images' as const}
  const unsupported = evaluateProjectFullTextGate({
    context,
    model: getDiscoveredModel(131_072, {
      capabilityOverrides: {supportsImageInput: false, updatedAt: '2026-10-17T10:00:00.000Z'},
    }),
    selection: nativeImages,
  })
  const unverified = evaluateProjectFullTextGate({context, model: getDiscoveredModel(131_072), selection: nativeImages})
  const supported = evaluateProjectFullTextGate({
    context,
    model: getDiscoveredModel(131_072, {
      capabilityOverrides: {supportsImageInput: true, updatedAt: '2026-10-17T10:00:00.000Z'},
    }),
    selection: nativeImages,
  })

  const textOnlyTransport = evaluateProjectFullTextGate({
    context,
    model: {...getDiscoveredModel(131_072), providerKind: 'mineru'},
    selection: nativeImages,
  })

  expect(unsupported.errors).toEqual([
    'Model Judge (sglang) cannot receive images. Choose Text only (figures reduced to their captions), or another model.',
  ])
  expect(unverified.errors).toEqual([
    'Model Judge (sglang) has no verified image input. Set it on the Models page, or choose Text only (figures reduced to their captions), or another model.',
  ])
  expect(supported.errors).toEqual([])
  expect(textOnlyTransport.errors).toEqual([
    'Model Judge (mineru) cannot receive images. Choose Text only (figures reduced to their captions), or another model.',
  ])
})

test('native images without image transports in this build is the resolver error', () => {
  const gate = evaluateProjectFullTextGate({
    context: {...context, environment: {...environment, imageTransportVersion: null}},
    model: getDiscoveredModel(131_072, {
      capabilityOverrides: {supportsImageInput: true, updatedAt: '2026-10-17T10:00:00.000Z'},
    }),
    selection: {...selection, fullTextFigureMode: 'native_images'},
  })

  expect(gate.errors).toEqual([fullTextStrategyErrorMessages.imageTransportMissing])
})

test('text only passes for a model that cannot receive images', () => {
  const gate = evaluateProjectFullTextGate({
    context,
    model: getDiscoveredModel(131_072, {
      capabilityOverrides: {supportsImageInput: false, updatedAt: '2026-10-17T10:00:00.000Z'},
    }),
    selection,
  })

  expect(gate.errors).toEqual([])
  expect(gate.strategy?.inputs.figureMode).toBe('none')
})

test('text only resolves the same strategy for vision, non-vision, unverified and text-transport models', () => {
  const getImageModel = (supportsImageInput: boolean) => {
    return getDiscoveredModel(131_072, {
      capabilityOverrides: {supportsImageInput, updatedAt: '2026-10-17T10:00:00.000Z'},
    })
  }
  const models = [
    getImageModel(true),
    getImageModel(false),
    getDiscoveredModel(131_072),
    {...getDiscoveredModel(131_072), providerKind: 'mineru'},
  ]
  const textOnlyGates = models.map((model) => {
    return evaluateProjectFullTextGate({context, model, selection})
  })
  const imageGates = models.map((model) => {
    return evaluateProjectFullTextGate({context, model, selection: {...selection, fullTextFigureMode: 'native_images'}})
  })

  expect(
    textOnlyGates.map((gate) => {
      return gate.errors
    }),
  ).toEqual([[], [], [], []])
  expect(
    new Set(
      textOnlyGates.map((gate) => {
        return JSON.stringify(gate.strategy)
      }),
    ).size,
  ).toBe(1)
  expect(textOnlyGates[0]?.strategy?.inputs).toMatchObject({figureMode: 'none', imageTransportVersion: null})
  expect(
    imageGates.map((gate) => {
      return gate.errors.length
    }),
  ).toEqual([0, 1, 1, 1])
})

test('a stored descriptions figure mode reads as no figure mode and needs an explicit choice', () => {
  const gate = evaluateStoredProjectFullTextGate({
    context,
    model: getDiscoveredModel(131_072),
    project: {
      fullTextChunkPolicy: selection.fullTextChunkPolicy,
      fullTextFigureMode: 'descriptions',
      fullTextStrategyId: null,
      fullTextStrategyInputs: null,
      fullTextStrategyStoredLabel: null,
      useFulltext: true,
      useFulltextNoImages: false,
    },
  })

  expect(gate.errors).toEqual([fullTextStrategyErrorMessages.figureModeMissing])
  expect(gate.strategy).toBeNull()
})

test('a failed PDF-to-text health check is a warning, not an error', () => {
  const gate = evaluateProjectFullTextGate({
    context: {
      ...context,
      conversionModelStatus: getFullTextModelStatusFromRow(
        getStatusRow({lastError: 'connect ECONNREFUSED 127.0.0.1:8000'}),
        'pdf_conversion',
      ),
    },
    model: getDiscoveredModel(131_072),
    selection,
  })

  expect(gate.errors).toEqual([])
  expect(gate.warnings).toEqual([
    'PDF-to-text model MinerU standard: The last health check of MinerU failed at 2026-10-17 20:15 UTC: connect ECONNREFUSED 127.0.0.1:8000. Conversion will not run until the server is reachable.',
  ])
})

test('a stored strategy that differs from the resolved one names both labels, ids and the differing inputs', () => {
  const current = resolveFullTextStrategy({chunkPolicy: selection.fullTextChunkPolicy, figureMode: 'none'}, environment)
  const stored = resolveFullTextStrategy(
    {chunkPolicy: selection.fullTextChunkPolicy, figureMode: 'none'},
    {...environment, conversionModel: {...conversionModel, converterVersion: '4.0.11'}},
  )

  if (!current.strategy || !stored.strategy) {
    throw new Error('Expected both strategies to resolve')
  }

  const project = {
    fullTextChunkPolicy: JSON.stringify(selection.fullTextChunkPolicy),
    fullTextFigureMode: 'none',
    fullTextStrategyId: stored.strategy.id,
    fullTextStrategyInputs: JSON.stringify(stored.strategy.inputs),
    fullTextStrategyStoredLabel: stored.strategy.label,
    useFulltext: true,
    useFulltextNoImages: false,
  }
  const changed = evaluateStoredProjectFullTextGate({context, model: getDiscoveredModel(131_072), project})
  const unchanged = evaluateStoredProjectFullTextGate({
    context,
    model: getDiscoveredModel(131_072),
    project: {
      ...project,
      fullTextStrategyId: current.strategy.id,
      fullTextStrategyInputs: JSON.stringify(current.strategy.inputs),
      fullTextStrategyStoredLabel: current.strategy.label,
    },
  })

  expect(changed.errors).toEqual([
    `Full-text settings changed since the project was saved: it records mineru 4.0.11 / none / chunked 48k (${stored.strategy.id}), current settings resolve to mineru 4.0.12 / none / chunked 48k (${current.strategy.id}); differing inputs: converterVersion. Save the project on its edit page to record the new strategy.`,
  ])
  expect(unchanged.errors).toEqual([])
})

test('a legacy no-images project must choose explicit settings before judging', () => {
  const gate = evaluateStoredProjectFullTextGate({
    context,
    model: getDiscoveredModel(131_072),
    project: {
      fullTextChunkPolicy: null,
      fullTextFigureMode: null,
      fullTextStrategyId: 'fts-legacy-v0',
      fullTextStrategyInputs: null,
      fullTextStrategyStoredLabel: null,
      useFulltext: false,
      useFulltextNoImages: true,
    },
  })

  expect(gate.errors).toEqual([
    fullTextStrategyErrorMessages.figureModeMissing,
    fullTextStrategyErrorMessages.chunkPolicyMissing,
  ])
})

test('a missing Unpaywall email is a warning naming the remaining fetch sources', () => {
  const gate = evaluateProjectFullTextGate({
    context: {...context, articleFetch: {unpaywallEmailSet: false}},
    model: getDiscoveredModel(131_072),
    selection,
  })

  expect(gate.errors).toEqual([])
  expect(gate.warnings).toEqual([
    'No Unpaywall email is set in Settings; PDFs are fetched only from publisher URLs and arXiv.',
  ])
})

test('a failed health check of the judging model connection is a warning about its refreshed capabilities', () => {
  const model = {
    ...getDiscoveredModel(32_768),
    connectionHealth: {
      lastCheckedAt: '2026-10-18T05:00:00.000Z',
      lastError: 'llama.cpp http://127.0.0.1:8080/props did not report default_generation_settings.n_ctx',
      providerLabel: 'llama.cpp',
    },
  }
  const failed = evaluateProjectFullTextGate({context, model, selection: {...selection, fullTextChunkPolicy: null}})
  const healthy = evaluateProjectFullTextGate({
    context,
    model: {...model, connectionHealth: {...model.connectionHealth, lastError: null}},
    selection: {...selection, fullTextChunkPolicy: null},
  })

  expect(failed.warnings).toEqual([
    'Judging model Judge (sglang): The last health check of llama.cpp failed at 2026-10-18 05:00 UTC: llama.cpp http://127.0.0.1:8080/props did not report default_generation_settings.n_ctx. Its context window and image input come from the last successful model refresh.',
  ])
  expect(healthy.warnings).toEqual([])
})
