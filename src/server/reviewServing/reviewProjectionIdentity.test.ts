import {expect, test} from 'bun:test'

import {
  buildComposedRouteIdentity,
  buildPromptConfigHash,
  buildReviewConfigHash,
  buildReviewDisplayIdentity,
  buildReviewJudgmentInputContentIdentity,
  buildReviewProjectionIdentity,
  buildReviewProjectScopeIdentity,
  buildReviewSearchIdentity,
  buildSummaryDefinitionIdentity,
  getComposedRouteIdentityJson,
  getStableReviewServingJson,
} from './reviewProjectionIdentity.ts'

test('getStableReviewServingJson is stable for equivalent object key order', () => {
  const left = getStableReviewServingJson({b: '2', a: {d: '4', c: '3'}})
  const right = getStableReviewServingJson({a: {c: '3', d: '4'}, b: '2'})

  expect(left).toBe(right)
})

test('buildReviewProjectionIdentity keeps projection components narrow', () => {
  const displayIdentity = buildReviewProjectionIdentity({
    component: 'display',
    definitionVersion: 'display:v1',
    upstreamDigests: {articleDisplay: 'digest-a'},
  })
  const searchIdentity = buildReviewProjectionIdentity({
    component: 'search',
    definitionVersion: 'search:v1',
    upstreamDigests: {articleDisplay: 'digest-a'},
  })

  expect(displayIdentity).not.toBe(searchIdentity)
  expect(displayIdentity.startsWith('display:')).toBe(true)
  expect(searchIdentity.startsWith('search:')).toBe(true)
})

test('buildReviewProjectionIdentity ignores physical patch counters', () => {
  const baseIdentity = buildReviewProjectionIdentity({
    component: 'display',
    definitionVersion: 'display:v1',
    upstreamDigests: {articleDisplay: 'digest-a'},
  })
  const advancedPatchIdentity = buildReviewProjectionIdentity({
    baseGeneration: '42',
    component: 'display',
    definitionVersion: 'display:v1',
    patchWatermark: '84',
    upstreamDigests: {articleDisplay: 'digest-a'},
  })

  expect(advancedPatchIdentity).toBe(baseIdentity)
})

test('specific projection builders are stable for equivalent dependency ordering', () => {
  const displayLeft = buildReviewDisplayIdentity({
    definitionVersion: 'display:v1',
    displayDependencyKeys: ['journalTitle', 'articleTitle'],
  })
  const displayRight = buildReviewDisplayIdentity({
    definitionVersion: 'display:v1',
    displayDependencyKeys: ['articleTitle', 'journalTitle'],
  })
  const searchLeft = buildReviewSearchIdentity({
    definitionVersion: 'search:v1',
    searchDependencyKeys: ['abstractText', 'articleTitle'],
    tokenizerVersion: 'tokenizer:v1',
  })
  const searchRight = buildReviewSearchIdentity({
    definitionVersion: 'search:v1',
    searchDependencyKeys: ['articleTitle', 'abstractText'],
    tokenizerVersion: 'tokenizer:v1',
  })
  const judgmentInputLeft = buildReviewJudgmentInputContentIdentity({
    contentDependencyKeys: ['fullText', 'title'],
    definitionVersion: 'judgment-input:v1',
    useAbstract: false,
    useFulltext: true,
    useFulltextNoImages: true,
    useTitle: true,
  })
  const judgmentInputRight = buildReviewJudgmentInputContentIdentity({
    contentDependencyKeys: ['title', 'fullText'],
    definitionVersion: 'judgment-input:v1',
    useAbstract: false,
    useFulltext: true,
    useFulltextNoImages: true,
    useTitle: true,
  })
  const projectScopeLeft = buildReviewProjectScopeIdentity({
    definitionVersion: 'project-scope:v1',
    projectScopeDependencyKeys: ['route:b', 'route:a'],
  })
  const projectScopeRight = buildReviewProjectScopeIdentity({
    definitionVersion: 'project-scope:v1',
    projectScopeDependencyKeys: ['route:a', 'route:b'],
  })

  expect(displayLeft).toBe(displayRight)
  expect(searchLeft).toBe(searchRight)
  expect(judgmentInputLeft).toBe(judgmentInputRight)
  expect(projectScopeLeft).toBe(projectScopeRight)
})

test('display search judgment-input project-scope prompt and review identities advance independently', () => {
  const promptConfig = buildPromptConfigHash({
    answerSchemaHash: 'answer-a',
    promptId: 'prompt-a',
    promptTextHash: 'text-a',
    settingsVersion: 'settings:v1',
    thresholdVersion: null,
  })
  const baseline = {
    display: buildReviewDisplayIdentity({definitionVersion: 'display:v1', displayDependencyKeys: ['title']}),
    judgmentInputContent: buildReviewJudgmentInputContentIdentity({
      contentDependencyKeys: ['title'],
      definitionVersion: 'judgment-input:v1',
      useAbstract: true,
      useFulltext: false,
      useFulltextNoImages: false,
      useTitle: true,
    }),
    projectScope: buildReviewProjectScopeIdentity({
      definitionVersion: 'project-scope:v1',
      projectScopeDependencyKeys: ['project-article:a'],
    }),
    promptConfig,
    reviewConfig: buildReviewConfigHash({
      humanJudgmentMode: 'prompt',
      modelExecutionIdentity: {providerConnectionId: 'provider-a', remoteModelId: 'model-a', variant: 'thinking'},
      modelId: 'model-a',
      promptConfigs: [{promptConfigHash: promptConfig, promptId: 'prompt-a', promptOrder: 1}],
      useAbstract: true,
      useFulltext: false,
      useFulltextNoImages: false,
      useTitle: true,
    }),
    search: buildReviewSearchIdentity({
      definitionVersion: 'search:v1',
      searchDependencyKeys: ['title'],
      tokenizerVersion: 'tokenizer:v1',
    }),
  }
  const changedIdentities = {
    display: {
      ...baseline,
      display: buildReviewDisplayIdentity({
        definitionVersion: 'display:v1',
        displayDependencyKeys: ['title', 'journal'],
      }),
    },
    judgmentInputContent: {
      ...baseline,
      judgmentInputContent: buildReviewJudgmentInputContentIdentity({
        contentDependencyKeys: ['title', 'abstract'],
        definitionVersion: 'judgment-input:v1',
        useAbstract: true,
        useFulltext: false,
        useFulltextNoImages: false,
        useTitle: true,
      }),
    },
    projectScope: {
      ...baseline,
      projectScope: buildReviewProjectScopeIdentity({
        definitionVersion: 'project-scope:v1',
        projectScopeDependencyKeys: ['project-article:a', 'project-article:b'],
      }),
    },
    promptConfig: {
      ...baseline,
      promptConfig: buildPromptConfigHash({
        answerSchemaHash: 'answer-b',
        promptId: 'prompt-a',
        promptTextHash: 'text-a',
        settingsVersion: 'settings:v1',
        thresholdVersion: null,
      }),
    },
    reviewConfig: {
      ...baseline,
      reviewConfig: buildReviewConfigHash({
        humanJudgmentMode: 'summary',
        modelExecutionIdentity: {providerConnectionId: 'provider-a', remoteModelId: 'model-a', variant: 'thinking'},
        modelId: 'model-a',
        promptConfigs: [{promptConfigHash: promptConfig, promptId: 'prompt-a', promptOrder: 1}],
        useAbstract: true,
        useFulltext: false,
        useFulltextNoImages: false,
        useTitle: true,
      }),
    },
    search: {
      ...baseline,
      search: buildReviewSearchIdentity({
        definitionVersion: 'search:v1',
        searchDependencyKeys: ['title', 'abstract'],
        tokenizerVersion: 'tokenizer:v1',
      }),
    },
  }

  expect(
    Object.entries(changedIdentities).map(([changedIdentity, identities]) => {
      const changedKeys = Object.keys(identities).filter((identityKey) => {
        return identities[identityKey as keyof typeof baseline] !== baseline[identityKey as keyof typeof baseline]
      })

      return [changedIdentity, changedKeys]
    }),
  ).toEqual([
    ['display', ['display']],
    ['judgmentInputContent', ['judgmentInputContent']],
    ['projectScope', ['projectScope']],
    ['promptConfig', ['promptConfig']],
    ['reviewConfig', ['reviewConfig']],
    ['search', ['search']],
  ])
})

test('specific identity builders ignore unrelated projection inputs', () => {
  const displayInput = {definitionVersion: 'display:v1', displayDependencyKeys: ['articleTitle']}
  const displayIdentity = buildReviewDisplayIdentity(displayInput)
  const displayWithUnrelatedInput = buildReviewDisplayIdentity({
    ...displayInput,
    searchDependencyKeys: ['abstractText'],
  } as typeof displayInput & {searchDependencyKeys: readonly string[]})
  const promptInput = {
    answerSchemaHash: 'answer-a',
    promptId: 'prompt-a',
    promptTextHash: 'text-a',
    settingsVersion: 'settings:v1',
    thresholdVersion: null,
  }
  const promptConfigHash = buildPromptConfigHash(promptInput)
  const promptConfigHashWithUnrelatedInput = buildPromptConfigHash({
    ...promptInput,
    displayIdentity,
  } as typeof promptInput & {displayIdentity: string})

  expect(displayIdentity).toBe(displayWithUnrelatedInput)
  expect(promptConfigHash).toBe(promptConfigHashWithUnrelatedInput)
})

test('buildReviewConfigHash sorts prompt configs before hashing', () => {
  const promptA = buildPromptConfigHash({
    answerSchemaHash: 'answer-a',
    promptId: 'prompt-a',
    promptTextHash: 'text-a',
    settingsVersion: 'settings:v1',
    thresholdVersion: null,
  })
  const promptB = buildPromptConfigHash({
    answerSchemaHash: 'answer-b',
    promptId: 'prompt-b',
    promptTextHash: 'text-b',
    settingsVersion: 'settings:v1',
    thresholdVersion: null,
  })
  const left = buildReviewConfigHash({
    humanJudgmentMode: 'prompt',
    modelExecutionIdentity: {providerConnectionId: 'provider-a', remoteModelId: 'model-a', variant: 'thinking'},
    modelId: 'model-a',
    promptConfigs: [
      {promptConfigHash: promptB, promptId: 'prompt-b', promptOrder: 2},
      {promptConfigHash: promptA, promptId: 'prompt-a', promptOrder: 1},
    ],
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
  })
  const right = buildReviewConfigHash({
    humanJudgmentMode: 'prompt',
    modelExecutionIdentity: {providerConnectionId: 'provider-a', remoteModelId: 'model-a', variant: 'thinking'},
    modelId: 'model-a',
    promptConfigs: [
      {promptConfigHash: promptA, promptId: 'prompt-a', promptOrder: 1},
      {promptConfigHash: promptB, promptId: 'prompt-b', promptOrder: 2},
    ],
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
  })

  expect(left).toBe(right)
})

test('buildReviewConfigHash changes when prompt order changes', () => {
  const input = {
    humanJudgmentMode: 'prompt',
    modelExecutionIdentity: {providerConnectionId: 'provider-a', remoteModelId: 'model-a', variant: 'thinking'},
    modelId: 'model-a',
    promptConfigs: [
      {promptConfigHash: 'prompt:a', promptId: 'prompt-a', promptOrder: 1},
      {promptConfigHash: 'prompt:b', promptId: 'prompt-b', promptOrder: 2},
    ],
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
  } as const
  const baseHash = buildReviewConfigHash(input)
  const reorderedHash = buildReviewConfigHash({
    ...input,
    promptConfigs: [
      {promptConfigHash: 'prompt:a', promptId: 'prompt-a', promptOrder: 2},
      {promptConfigHash: 'prompt:b', promptId: 'prompt-b', promptOrder: 1},
    ],
  })

  expect(reorderedHash).not.toBe(baseHash)
})

test('buildReviewConfigHash changes when model execution identity or human review mode changes', () => {
  const input = {
    humanJudgmentMode: 'prompt',
    modelExecutionIdentity: {providerConnectionId: 'provider-a', remoteModelId: 'model-a', thinking: 'medium'},
    modelId: 'model-a',
    promptConfigs: [{promptConfigHash: 'prompt:a', promptId: 'prompt-a', promptOrder: 1}],
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
  } as const
  const baseHash = buildReviewConfigHash(input)
  const changedExecutionHash = buildReviewConfigHash({
    ...input,
    modelExecutionIdentity: {providerConnectionId: 'provider-a', remoteModelId: 'model-a', thinking: 'high'},
  })
  const changedHumanModeHash = buildReviewConfigHash({...input, humanJudgmentMode: 'summary'})

  expect(changedExecutionHash).not.toBe(baseHash)
  expect(changedHumanModeHash).not.toBe(baseHash)
})

test('buildReviewConfigHash ignores unrelated projection inputs', () => {
  const input = {
    humanJudgmentMode: 'prompt',
    modelExecutionIdentity: {providerConnectionId: 'provider-a', remoteModelId: 'model-a', variant: 'thinking'},
    modelId: 'model-a',
    promptConfigs: [{promptConfigHash: 'prompt:a', promptId: 'prompt-a', promptOrder: 1}],
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
  } as const
  const left = buildReviewConfigHash(input)
  const right = buildReviewConfigHash({...input, displayIdentity: 'display:other'} as typeof input & {
    displayIdentity: string
  })

  expect(left).toBe(right)
})

test('buildReviewConfigHash changes when model execution settings change', () => {
  const input = {
    humanJudgmentMode: 'prompt',
    modelExecutionIdentity: {
      options: {thinking: {effort: 'medium'}},
      providerConnectionId: 'provider-a',
      remoteModelId: 'model-a',
      variant: 'thinking',
    },
    modelId: 'model-a',
    promptConfigs: [{promptConfigHash: 'prompt:a', promptId: 'prompt-a', promptOrder: 1}],
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
  } as const
  const baseHash = buildReviewConfigHash(input)
  const changedThinking = buildReviewConfigHash({
    ...input,
    modelExecutionIdentity: {...input.modelExecutionIdentity, options: {thinking: {effort: 'high'}}},
  })
  const changedVariant = buildReviewConfigHash({
    ...input,
    modelExecutionIdentity: {...input.modelExecutionIdentity, variant: 'non-thinking'},
  })

  expect(changedThinking).not.toBe(baseHash)
  expect(changedVariant).not.toBe(baseHash)
})

test('buildReviewConfigHash changes when human judgment mode changes', () => {
  const input = {
    humanJudgmentMode: 'prompt',
    modelExecutionIdentity: {providerConnectionId: 'provider-a', remoteModelId: 'model-a', variant: 'thinking'},
    modelId: 'model-a',
    promptConfigs: [{promptConfigHash: 'prompt:a', promptId: 'prompt-a', promptOrder: 1}],
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
  } as const
  const baseHash = buildReviewConfigHash(input)
  const summaryHash = buildReviewConfigHash({...input, humanJudgmentMode: 'summary'})

  expect(summaryHash).not.toBe(baseHash)
})

test('buildSummaryDefinitionIdentity sorts contribution keys before hashing', () => {
  const left = buildSummaryDefinitionIdentity({
    contributionKeys: ['answer:yes', 'answer:no'],
    summaryDefinitionVersion: 'summary:v1',
  })
  const right = buildSummaryDefinitionIdentity({
    contributionKeys: ['answer:no', 'answer:yes'],
    summaryDefinitionVersion: 'summary:v1',
  })

  expect(left).toBe(right)
})

test('buildComposedRouteIdentity uses only the route component dependency set', () => {
  const componentStates = {
    display: {baseGeneration: '1', patchWatermark: '2', projectionIdentity: 'display:aaa'},
    projectScope: {baseGeneration: '3', patchWatermark: '4', projectionIdentity: 'projectScope:bbb'},
    search: {baseGeneration: '5', patchWatermark: '6', projectionIdentity: 'search:ccc'},
  } as const
  const input = {
    componentStates,
    contractKey: 'review.llm.rows',
    optionalComponents: [],
    requiredComponents: ['projectScope', 'display'],
    reviewConfigHash: 'review:aaa',
    routeVersion: 'route:v1',
  } as const
  const reordered = buildComposedRouteIdentity({...input, requiredComponents: ['display', 'projectScope']})
  const withUnrelatedSearchChange = buildComposedRouteIdentity({
    ...input,
    componentStates: {
      ...componentStates,
      search: {baseGeneration: '9', patchWatermark: '9', projectionIdentity: 'search:changed'},
    },
  })
  const withSearchDependency = buildComposedRouteIdentity({...input, optionalComponents: ['search']})

  expect(buildComposedRouteIdentity(input)).toBe(reordered)
  expect(buildComposedRouteIdentity(input)).toBe(withUnrelatedSearchChange)
  expect(buildComposedRouteIdentity(input)).not.toBe(withSearchDependency)
})

test('getComposedRouteIdentityJson is stable for route component order', () => {
  const left = getComposedRouteIdentityJson({
    componentStates: {
      display: {baseGeneration: '1', patchWatermark: '2', projectionIdentity: 'display:aaa'},
      projectScope: {baseGeneration: '3', patchWatermark: '4', projectionIdentity: 'projectScope:bbb'},
    },
    contractKey: 'review.llm.rows',
    optionalComponents: [],
    requiredComponents: ['projectScope', 'display'],
    reviewConfigHash: 'review:aaa',
    routeVersion: 'route:v1',
  })
  const right = getComposedRouteIdentityJson({
    componentStates: {
      projectScope: {baseGeneration: '3', patchWatermark: '4', projectionIdentity: 'projectScope:bbb'},
      display: {baseGeneration: '1', patchWatermark: '2', projectionIdentity: 'display:aaa'},
    },
    contractKey: 'review.llm.rows',
    optionalComponents: [],
    requiredComponents: ['display', 'projectScope'],
    reviewConfigHash: 'review:aaa',
    routeVersion: 'route:v1',
  })

  expect(left).toBe(right)
})
