import {createHash} from 'node:crypto'

import {expect, test} from 'bun:test'

import {
  type ComparisonJudgmentContextServedColumn,
  getComparisonContentKey,
  getComparisonContentKeySettings,
  getComparisonJudgmentContext,
  getComparisonJudgmentContextCanonicalJson,
  getComparisonJudgmentContextId,
  getComparisonJudgmentContextModelIds,
  getComparisonJudgmentContextPromptIds,
  getComparisonJudgmentContextSystemPromptVariants,
  getUpsertComparisonJudgmentContextSql,
  getValidatedComparisonJudgmentContext,
  isComparisonJudgmentContextId,
} from './comparisonJudgmentContext.ts'

const summaryColumns: ComparisonJudgmentContextServedColumn[] = [
  {
    contentKey: '1100-screening_v1',
    criteriaDisposition: 'include',
    kind: 'llm',
    modelId: 'model-1',
    modelName: 'gpt-5.5',
    promptHeading: 'Intervention',
    promptId: 'prompt-b',
    sourceProjectId: 'source-1',
  },
  {
    contentKey: '1100m',
    criteriaDisposition: 'exclude',
    kind: 'llm',
    modelId: 'model-1',
    modelName: 'gpt-5.5',
    promptHeading: 'Population',
    promptId: 'prompt-a',
    sourceProjectId: 'source-1',
  },
  {
    contentKey: null,
    criteriaDisposition: null,
    kind: 'human',
    modelId: null,
    modelName: null,
    promptHeading: null,
    promptId: 'summary',
    sourceProjectId: null,
  },
]

const summaryContextParams = {
  humanJudgmentMode: 'summary' as const,
  sourceProjectIds: ['source-2', 'source-1'],
  summarySourceProjectId: 'source-1',
}

const summaryContextJson =
  '{"columns":[{"kind":"human","promptHeading":null,"promptId":"summary"},{"criteriaDisposition":"exclude","kind":"llm","modelId":"model-1","modelName":"gpt-5.5","promptHeading":"Population","promptId":"prompt-a","sourceProjectId":"source-1","systemPromptVariant":"legacy","useAbstract":true,"useFulltext":false,"useFulltextNoImages":false,"useMetadata":true,"useTitle":true},{"criteriaDisposition":"include","kind":"llm","modelId":"model-1","modelName":"gpt-5.5","promptHeading":"Intervention","promptId":"prompt-b","sourceProjectId":"source-1","systemPromptVariant":"screening_v1","useAbstract":true,"useFulltext":false,"useFulltextNoImages":false,"useMetadata":false,"useTitle":true}],"humanJudgmentMode":"summary","sourceProjectIds":["source-1","source-2"],"summarySourceProjectId":"source-1","v":1}'
const summaryContextId = '2168ca3cc7e7cb3c3fa173f7aeeff04314ed31e83a9b2b201695446a6461922a'

const getSummaryContext = (columns: readonly ComparisonJudgmentContextServedColumn[] = summaryColumns) => {
  return getComparisonJudgmentContext({...summaryContextParams, columns})
}

const replaceColumn = (index: number, patch: Partial<ComparisonJudgmentContextServedColumn>) => {
  return summaryColumns.map((column, columnIndex) => {
    return columnIndex === index ? {...column, ...patch} : column
  })
}

test('content keys decode back to the five flags and the system prompt variant', () => {
  expect(getComparisonContentKeySettings('1100')).toEqual({
    systemPromptVariant: 'legacy',
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useMetadata: false,
    useTitle: true,
  })
  expect(getComparisonContentKeySettings('0010m-screening_v1')).toEqual({
    systemPromptVariant: 'screening_v1',
    useAbstract: false,
    useFulltext: true,
    useFulltextNoImages: false,
    useMetadata: true,
    useTitle: false,
  })
  expect(getComparisonContentKeySettings('0001-screening_v1')).toEqual({
    systemPromptVariant: 'screening_v1',
    useAbstract: false,
    useFulltext: false,
    useFulltextNoImages: true,
    useMetadata: false,
    useTitle: false,
  })
  expect(getComparisonContentKeySettings(null)).toBeNull()
  expect(getComparisonContentKeySettings('default')).toBeNull()
  expect(getComparisonContentKeySettings('110')).toBeNull()
  expect(getComparisonContentKeySettings('1100x')).toBeNull()
  expect(getComparisonContentKeySettings('1100-')).toBeNull()
})

test('content keys round trip through the encoder used by the serving cell builder', () => {
  const keys = ['1100', '1100m', '1100-screening_v1', '1100m-screening_v1', '0010', '0001m']

  expect(
    keys.map((key) => {
      const settings = getComparisonContentKeySettings(key)

      return settings ? getComparisonContentKey(settings) : null
    }),
  ).toEqual(keys)
})

test('canonical context JSON has sorted keys, sorted columns and sorted source projects', () => {
  const context = getSummaryContext()

  expect(getComparisonJudgmentContextCanonicalJson(context)).toBe(summaryContextJson)
  expect(getComparisonJudgmentContextId(context)).toBe(summaryContextId)
  expect(getComparisonJudgmentContextPromptIds(context)).toEqual(['prompt-a', 'prompt-b'])
  expect(getComparisonJudgmentContextModelIds(context)).toEqual(['model-1'])
  expect(getComparisonJudgmentContextSystemPromptVariants(context)).toEqual(['legacy', 'screening_v1'])
})

test('the context id is the sha256 of the canonical JSON without display-only names', () => {
  const identityJson = summaryContextJson
    .replaceAll(/"modelName":"[^"]*",/g, '')
    .replaceAll(/"promptHeading":(null|"[^"]*"),/g, '')

  expect(identityJson).not.toContain('promptHeading')
  expect(createHash('sha256').update(identityJson).digest('hex')).toBe(summaryContextId)
})

test('the context id does not depend on column, source project or duplicate order', () => {
  const reordered = getComparisonJudgmentContext({
    ...summaryContextParams,
    columns: [...summaryColumns].reverse().concat(summaryColumns),
    sourceProjectIds: ['source-1', 'source-2', 'source-1'],
  })

  expect(getComparisonJudgmentContextCanonicalJson(reordered)).toBe(summaryContextJson)
  expect(getComparisonJudgmentContextId(reordered)).toBe(summaryContextId)
})

test('the context id changes with content flags, metadata, variant, prompt, model and disposition', () => {
  const variants = [
    replaceColumn(1, {contentKey: '1100'}),
    replaceColumn(1, {contentKey: '1000m'}),
    replaceColumn(0, {contentKey: '1100'}),
    replaceColumn(0, {promptId: 'prompt-c'}),
    replaceColumn(0, {modelId: 'model-2'}),
    replaceColumn(0, {criteriaDisposition: 'exclude'}),
    replaceColumn(0, {sourceProjectId: 'source-2'}),
  ]

  const variantIds = variants.map((columns) => {
    return getComparisonJudgmentContextId(getSummaryContext(columns))
  })

  expect(variantIds[0]).toBe('f2efc795ded1aa4e64f565aff914cf76d69215a211b4d7e7606877464088b264')
  expect(variantIds[2]).toBe('275099a73ab4dcfea0882d663ff29374797c3469eddbfb104819383c856f84ec')
  expect(
    new Set([
      summaryContextId,
      ...variants.map((columns) => {
        return getComparisonJudgmentContextId(getSummaryContext(columns))
      }),
    ]).size,
  ).toBe(variants.length + 1)
})

test('the context id ignores renamed models and prompt headings', () => {
  const renamed = getSummaryContext(replaceColumn(0, {modelName: 'GPT 5.5 (renamed)', promptHeading: 'Renamed'}))

  expect(getComparisonJudgmentContextCanonicalJson(renamed)).not.toBe(summaryContextJson)
  expect(getComparisonJudgmentContextId(renamed)).toBe(summaryContextId)
})

test('the human judgment mode and the summary source are part of the context id', () => {
  const promptMode = getComparisonJudgmentContext({
    ...summaryContextParams,
    columns: summaryColumns,
    humanJudgmentMode: 'prompt',
  })
  const otherSource = getComparisonJudgmentContext({
    ...summaryContextParams,
    columns: summaryColumns,
    summarySourceProjectId: 'source-2',
  })

  expect(getComparisonJudgmentContextId(promptMode)).not.toBe(summaryContextId)
  expect(getComparisonJudgmentContextId(otherSource)).not.toBe(summaryContextId)
})

test('prompt mode contexts pin exact hashes', () => {
  const context = getComparisonJudgmentContext({
    columns: [
      {
        contentKey: '1100',
        criteriaDisposition: null,
        kind: 'llm',
        modelId: 'model-1',
        modelName: 'gpt-5.5',
        promptHeading: 'Population',
        promptId: 'prompt-a',
        sourceProjectId: null,
      },
      {
        contentKey: null,
        criteriaDisposition: null,
        kind: 'human',
        modelId: null,
        modelName: null,
        promptHeading: 'Population',
        promptId: 'prompt-a',
        sourceProjectId: null,
      },
    ],
    humanJudgmentMode: 'prompt',
    sourceProjectIds: [],
    summarySourceProjectId: null,
  })

  expect(getComparisonJudgmentContextCanonicalJson(context)).toBe(
    '{"columns":[{"kind":"human","promptHeading":"Population","promptId":"prompt-a"},{"criteriaDisposition":null,"kind":"llm","modelId":"model-1","modelName":"gpt-5.5","promptHeading":"Population","promptId":"prompt-a","sourceProjectId":null,"systemPromptVariant":"legacy","useAbstract":true,"useFulltext":false,"useFulltextNoImages":false,"useMetadata":false,"useTitle":true}],"humanJudgmentMode":"prompt","sourceProjectIds":[],"summarySourceProjectId":null,"v":1}',
  )
  expect(getComparisonJudgmentContextId(context)).toBe(
    'c476af21fb34ec3cb0e1e60c8ad6b1472fe40d3f8b2ed2ef1cb32322da85531b',
  )
})

test('llm columns with an unreadable content key or no model are dropped', () => {
  const context = getSummaryContext([
    ...summaryColumns,
    {...summaryColumns[0], contentKey: 'default'} as ComparisonJudgmentContextServedColumn,
    {...summaryColumns[0], modelId: null} as ComparisonJudgmentContextServedColumn,
  ])

  expect(getComparisonJudgmentContextId(context)).toBe(summaryContextId)
})

test('validated contexts from untrusted JSON re-canonicalise to the same id', () => {
  const parsed = JSON.parse(summaryContextJson) as {columns: unknown[]}
  const shuffled = {...parsed, columns: [...parsed.columns].reverse()}

  expect(getValidatedComparisonJudgmentContext(JSON.stringify(shuffled))).toEqual(getSummaryContext())
  expect(getValidatedComparisonJudgmentContext(shuffled)).toEqual(getSummaryContext())
  expect(getValidatedComparisonJudgmentContext({...parsed, v: 2})).toBeNull()
  expect(getValidatedComparisonJudgmentContext({...parsed, columns: [{kind: 'llm'}]})).toBeNull()
  expect(getValidatedComparisonJudgmentContext('not json')).toBeNull()
})

test('context ids are lowercase sha256 hex strings', () => {
  expect(isComparisonJudgmentContextId(summaryContextId)).toBe(true)
  expect(isComparisonJudgmentContextId(summaryContextId.toUpperCase())).toBe(false)
  expect(isComparisonJudgmentContextId(`${summaryContextId}0`)).toBe(false)
  expect(isComparisonJudgmentContextId(null)).toBe(false)
})

test('the context upsert is content addressed and never overwrites', () => {
  const sql = getUpsertComparisonJudgmentContextSql(getSummaryContext())

  expect(sql).toContain(`'${summaryContextId}'`)
  expect(sql).toContain('ON CONFLICT DO NOTHING')
  expect(sql).toContain("['prompt-a', 'prompt-b']")
  expect(sql).toContain("['legacy', 'screening_v1']")
  expect(sql).not.toContain('DO UPDATE')
})
