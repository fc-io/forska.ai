import {createHash} from 'node:crypto'

import {expect, test} from 'bun:test'

import {
  type ComparisonJudgmentContextColumnRow,
  type ComparisonJudgmentContextCriterionRow,
  getCanonicalJson,
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

const getLlmRow = (overrides: Partial<ComparisonJudgmentContextColumnRow> = {}): ComparisonJudgmentContextColumnRow => {
  return {
    contentKey: '1100',
    kind: 'llm',
    modelId: 'model-1',
    modelName: 'gpt-5.5',
    promptHeading: null,
    promptId: 'summary',
    sourceProjectId: 'source-1',
    systemPromptVariant: 'legacy',
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useMetadata: false,
    useTitle: true,
    ...overrides,
  }
}

const humanSummaryRow: ComparisonJudgmentContextColumnRow = {
  contentKey: null,
  kind: 'human',
  modelId: null,
  modelName: null,
  promptHeading: null,
  promptId: 'summary',
  sourceProjectId: null,
  systemPromptVariant: null,
  useAbstract: null,
  useFulltext: null,
  useFulltextNoImages: null,
  useMetadata: null,
  useTitle: null,
}

const summaryLlmRow = getLlmRow({
  contentKey: '1100m-screening_v1',
  systemPromptVariant: 'screening_v1',
  useMetadata: true,
})
const summaryColumns = [summaryLlmRow, humanSummaryRow]

const getCriterion = (overrides: Partial<ComparisonJudgmentContextCriterionRow> = {}) => {
  return {
    criteriaDisposition: 'include',
    promptHeading: 'Population',
    promptId: 'prompt-a',
    sourceProjectId: 'source-1',
    ...overrides,
  }
}

const summaryCriteria: ComparisonJudgmentContextCriterionRow[] = [
  getCriterion({criteriaDisposition: 'exclude', promptHeading: 'Exclusion', promptId: 'prompt-b'}),
  getCriterion(),
]

const summaryContextParams = {
  humanJudgmentMode: 'summary' as const,
  sourceProjectIds: ['source-2', 'source-1'],
  summarySourceProjectId: 'source-1',
}

const summaryContextJson =
  '{"columns":[{"kind":"human","promptHeading":null,"promptId":"summary"},{"contentKey":"1100m-screening_v1","criteria":[{"criteriaDisposition":"include","promptHeading":"Population","promptId":"prompt-a"},{"criteriaDisposition":"exclude","promptHeading":"Exclusion","promptId":"prompt-b"}],"kind":"llm","modelId":"model-1","modelName":"gpt-5.5","promptHeading":null,"promptId":"summary","sourceProjectId":"source-1","systemPromptVariant":"screening_v1","useAbstract":true,"useFulltext":false,"useFulltextNoImages":false,"useMetadata":true,"useTitle":true}],"humanJudgmentMode":"summary","sourceProjectIds":["source-1","source-2"],"summarySourceProjectId":"source-1","v":1}'
const summaryContextId = '3c492403ae1ff57a1556864f5564c4e68d64c23a10773c38caa51d9e81aa52a5'

const getSummaryContext = (
  columns: readonly ComparisonJudgmentContextColumnRow[] = summaryColumns,
  criteria: readonly ComparisonJudgmentContextCriterionRow[] = summaryCriteria,
) => {
  return getComparisonJudgmentContext({...summaryContextParams, columns, criteria})
}

const getSummaryContextId = (
  columns: readonly ComparisonJudgmentContextColumnRow[] = summaryColumns,
  criteria: readonly ComparisonJudgmentContextCriterionRow[] = summaryCriteria,
) => {
  return getComparisonJudgmentContextId(getSummaryContext(columns, criteria))
}

test('canonical context JSON sorts keys, columns, criteria and source projects', () => {
  const context = getSummaryContext()

  expect(getComparisonJudgmentContextCanonicalJson(context)).toBe(summaryContextJson)
  expect(getComparisonJudgmentContextId(context)).toBe(summaryContextId)
  expect(getComparisonJudgmentContextPromptIds(context)).toEqual(['prompt-a', 'prompt-b'])
  expect(getComparisonJudgmentContextModelIds(context)).toEqual(['model-1'])
  expect(getComparisonJudgmentContextSystemPromptVariants(context)).toEqual(['screening_v1'])
})

test('the context id is the sha256 of the canonical JSON without display-only names', () => {
  const identityJson = summaryContextJson
    .replaceAll(/"modelName":"[^"]*",/g, '')
    .replaceAll(/"promptHeading":(null|"[^"]*"),/g, '')

  expect(identityJson).not.toContain('promptHeading')
  expect(createHash('sha256').update(identityJson).digest('hex')).toBe(summaryContextId)
})

test('the context id does not depend on column, criteria, source project or duplicate order', () => {
  const reordered = getComparisonJudgmentContext({
    ...summaryContextParams,
    columns: [...summaryColumns].reverse().concat(summaryColumns),
    criteria: [...summaryCriteria].reverse().concat(summaryCriteria),
    sourceProjectIds: ['source-1', 'source-2', 'source-1'],
  })

  expect(getComparisonJudgmentContextCanonicalJson(reordered)).toBe(summaryContextJson)
  expect(getComparisonJudgmentContextId(reordered)).toBe(summaryContextId)
})

test('the context id changes with content flags, metadata, variant, model, source, criteria and dispositions', () => {
  const changedIds = [
    getSummaryContextId([getLlmRow({contentKey: '1100m', useMetadata: true}), humanSummaryRow]),
    getSummaryContextId([{...summaryLlmRow, contentKey: '1000m-screening_v1', useAbstract: false}, humanSummaryRow]),
    getSummaryContextId([{...summaryLlmRow, modelId: 'model-2'}, humanSummaryRow]),
    getSummaryContextId([{...summaryLlmRow, sourceProjectId: 'source-2'}, humanSummaryRow]),
    getSummaryContextId(summaryColumns, summaryCriteria.slice(1)),
    getSummaryContextId(summaryColumns, [
      getCriterion({criteriaDisposition: 'exclude'}),
      summaryCriteria[0] ?? getCriterion(),
    ]),
    getSummaryContextId(summaryColumns, [...summaryCriteria, getCriterion({promptId: 'prompt-c'})]),
  ]

  expect(new Set([summaryContextId, ...changedIds]).size).toBe(changedIds.length + 1)
})

test('a summary column whose criteria list is empty is kept with an empty list and hashes differently', () => {
  const context = getSummaryContext(summaryColumns, [])
  const humanOnlyContext = getComparisonJudgmentContext({
    ...summaryContextParams,
    columns: [humanSummaryRow],
    criteria: [],
  })

  expect(
    context.columns.find((column) => {
      return column.kind === 'llm'
    }),
  ).toMatchObject({criteria: [], promptId: 'summary', sourceProjectId: 'source-1'})
  expect(getComparisonJudgmentContextId(context)).toBe(
    '039f7291f546cad594c74e1daf430951894bb18e60571f82be65336f671e1dd4',
  )
  expect(getComparisonJudgmentContextId(humanOnlyContext)).not.toBe(getComparisonJudgmentContextId(context))
})

test('every LLM column keeps its raw content key, including keys the encoder would not produce', () => {
  const context = getComparisonJudgmentContext({
    columns: [
      getLlmRow({promptId: 'prompt-a', sourceProjectId: null}),
      getLlmRow({contentKey: 'default', promptId: 'prompt-a', sourceProjectId: null}),
    ],
    criteria: [],
    humanJudgmentMode: 'prompt',
    sourceProjectIds: [],
    summarySourceProjectId: null,
  })

  expect(
    context.columns.map((column) => {
      return column.kind === 'llm' ? column.contentKey : null
    }),
  ).toEqual(['1100', 'default'])
})

test('the context id ignores renamed models and prompt and criterion headings', () => {
  const renamed = getSummaryContext(
    [{...summaryLlmRow, modelName: 'GPT 5.5 (renamed)'}, humanSummaryRow],
    summaryCriteria.map((criterion) => {
      return {...criterion, promptHeading: `${criterion.promptHeading ?? ''} renamed`}
    }),
  )

  expect(getComparisonJudgmentContextCanonicalJson(renamed)).not.toBe(summaryContextJson)
  expect(getComparisonJudgmentContextId(renamed)).toBe(summaryContextId)
})

test('the human judgment mode and the summary source are part of the context id', () => {
  const promptMode = getComparisonJudgmentContext({
    ...summaryContextParams,
    columns: summaryColumns,
    criteria: summaryCriteria,
    humanJudgmentMode: 'prompt',
  })
  const otherSource = getComparisonJudgmentContext({
    ...summaryContextParams,
    columns: summaryColumns,
    criteria: summaryCriteria,
    summarySourceProjectId: 'source-2',
  })

  expect(getComparisonJudgmentContextId(promptMode)).not.toBe(summaryContextId)
  expect(getComparisonJudgmentContextId(otherSource)).not.toBe(summaryContextId)
})

test('prompt mode contexts pin exact hashes and carry no criteria', () => {
  const context = getComparisonJudgmentContext({
    columns: [
      getLlmRow({promptHeading: 'Population', promptId: 'prompt-a', sourceProjectId: null}),
      {...humanSummaryRow, promptHeading: 'Population', promptId: 'prompt-a'},
    ],
    criteria: summaryCriteria,
    humanJudgmentMode: 'prompt',
    sourceProjectIds: [],
    summarySourceProjectId: null,
  })

  expect(getComparisonJudgmentContextCanonicalJson(context)).toBe(
    '{"columns":[{"kind":"human","promptHeading":"Population","promptId":"prompt-a"},{"contentKey":"1100","kind":"llm","modelId":"model-1","modelName":"gpt-5.5","promptHeading":"Population","promptId":"prompt-a","sourceProjectId":null,"systemPromptVariant":"legacy","useAbstract":true,"useFulltext":false,"useFulltextNoImages":false,"useMetadata":false,"useTitle":true}],"humanJudgmentMode":"prompt","sourceProjectIds":[],"summarySourceProjectId":null,"v":1}',
  )
  expect(getComparisonJudgmentContextId(context)).toBe(
    'fb3bb50bf50014506e8c8140cf90d12e5355d84d37153b5f7eff5a42e0b21cb9',
  )
})

test('validated contexts from untrusted JSON re-canonicalise to the same id and drop unknown keys', () => {
  const parsed = JSON.parse(summaryContextJson) as {columns: Array<Record<string, unknown>>}
  const shuffled = {
    ...parsed,
    columns: [...parsed.columns].reverse().map((column) => {
      return {...column, injected: 'ignored'}
    }),
  }

  expect(getValidatedComparisonJudgmentContext(JSON.stringify(shuffled))).toEqual(getSummaryContext())
  expect(getCanonicalJson(getValidatedComparisonJudgmentContext(shuffled))).toBe(summaryContextJson)
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
  expect(sql).toContain("['screening_v1']")
  expect(sql).not.toContain('DO UPDATE')
})
