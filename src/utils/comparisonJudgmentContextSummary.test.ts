import {expect, test} from 'bun:test'

import type {
  ComparisonJudgmentContextLlmColumn,
  ComparisonJudgmentContextSummary,
  ComparisonProjectJudgmentsRow,
} from '../services/comparisonProjectsService.ts'
import {
  getComparisonJudgmentContextIds,
  getComparisonJudgmentContextSummariesById,
  getComparisonJudgmentContextSummaryLines,
} from './comparisonJudgmentContextSummary.ts'

const otherSettingsLine =
  'Other settings differ from the current prompts (source projects, human judgment mode or how columns combine these settings)'

const getRow = (id: string, contextId: string | null | undefined): ComparisonProjectJudgmentsRow => {
  return {
    articleCreatedAt: null,
    articleExternalId: null,
    articleSummary: null,
    articleTitle: id,
    canonicalArticleId: id,
    cells: {},
    conflictResolution:
      contextId === undefined
        ? null
        : {
            articleId: id,
            label: 'yes',
            provenance: {contextId, generation: null, origin: 'ui', setAt: null},
            provenanceMatchesCurrent: null,
            reviewer: null,
            reviewerDisplayName: null,
            reviewerUserId: null,
            setAt: null,
            value: 'yes',
          },
    hasConflict: true,
    id,
  }
}

const getLlmColumn = (
  overrides: Partial<ComparisonJudgmentContextLlmColumn> = {},
): ComparisonJudgmentContextLlmColumn => {
  return {
    contentKey: '1100',
    kind: 'llm',
    modelId: 'model-a',
    modelName: 'gpt-5.5',
    promptHeading: 'Population',
    promptId: 'prompt-1',
    sourceProjectId: 'project-1',
    systemPromptVariant: 'legacy',
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useMetadata: false,
    useTitle: true,
    ...overrides,
  }
}

const getSummary = (
  id: string,
  overrides: Partial<ComparisonJudgmentContextSummary> = {},
): ComparisonJudgmentContextSummary => {
  return {
    context: {
      columns: [
        getLlmColumn(),
        getLlmColumn({modelId: 'model-b', modelName: null}),
        {kind: 'human', promptHeading: null, promptId: 'summary'},
      ],
      humanJudgmentMode: 'prompt',
      sourceProjectIds: ['project-1'],
      summarySourceProjectId: null,
      v: 1,
    },
    createdAt: null,
    id,
    modelIds: ['model-a', 'model-b'],
    models: [
      {id: 'model-a', name: 'gpt-5.5'},
      {id: 'model-b', name: null},
    ],
    promptIds: ['prompt-1', 'prompt-2'],
    prompts: [
      {heading: 'Population', id: 'prompt-1'},
      {heading: ' ', id: 'prompt-2'},
      {heading: null, id: 'summary'},
    ],
    systemPromptVariants: ['legacy'],
    ...overrides,
  }
}

const getSummaryModeSummary = (
  id: string,
  criteria: NonNullable<ComparisonJudgmentContextLlmColumn['criteria']>,
): ComparisonJudgmentContextSummary => {
  return getSummary(id, {
    context: {
      columns: [getLlmColumn({criteria, promptHeading: null, promptId: 'summary'})],
      humanJudgmentMode: 'summary',
      sourceProjectIds: ['project-1'],
      summarySourceProjectId: 'project-1',
      v: 1,
    },
    modelIds: ['model-a'],
    models: [{id: 'model-a', name: 'gpt-5.5'}],
    prompts: [
      {heading: null, id: 'summary'},
      ...criteria.map((criterion) => {
        return {heading: criterion.promptHeading, id: criterion.promptId}
      }),
    ],
  })
}

test('collects the distinct context ids of a page in sorted order, without the excluded current id', () => {
  const rows = [
    getRow('a', 'context-b'),
    getRow('b', null),
    getRow('c', undefined),
    getRow('d', 'context-a'),
    getRow('e', 'context-b'),
    getRow('f', 'context-current'),
  ]

  expect(getComparisonJudgmentContextIds(rows)).toEqual(['context-a', 'context-b', 'context-current'])
  expect(getComparisonJudgmentContextIds(rows, 'context-current')).toEqual(['context-a', 'context-b'])
  expect(getComparisonJudgmentContextIds([getRow('a', 'context-current')], 'context-current')).toEqual([])
})

test('indexes fetched summaries by id and adds the current summary', () => {
  const fetched = getSummary('context-old')
  const current = getSummary('context-current')

  expect(getComparisonJudgmentContextSummariesById([fetched], current)).toEqual({
    'context-current': current,
    'context-old': fetched,
  })
  expect(getComparisonJudgmentContextSummariesById([])).toEqual({})
})

test('summarizes models, variants, prompt headings and server-decoded content without the summary column', () => {
  expect(getComparisonJudgmentContextSummaryLines(getSummary('context-1'))).toEqual([
    'Models: gpt-5.5, model-b',
    'System prompt variants: legacy',
    'Prompts: Population, prompt-2',
    'Content: title + abstract',
  ])
})

test('marks entries the current prompts no longer use', () => {
  const current = getSummary('context-current', {
    models: [{id: 'model-a', name: 'gpt-5.5'}],
    prompts: [{heading: 'Population', id: 'prompt-1-v2'}],
  })
  const older = getSummary('context-older', {
    models: [{id: 'model-a', name: 'gpt-5.5'}],
    prompts: [{heading: 'Population', id: 'prompt-1'}],
  })

  expect(getComparisonJudgmentContextSummaryLines(older, current)).toEqual([
    'Models: gpt-5.5',
    'System prompt variants: legacy',
    'Prompts: Population (no longer used); added since: Population',
    'Content: title + abstract',
  ])
  expect(getComparisonJudgmentContextSummaryLines(current, current)).toEqual([
    'Models: gpt-5.5',
    'System prompt variants: legacy',
    'Prompts: Population',
    'Content: title + abstract',
  ])
})

test('lists entries added since without the generic line when only additions explain the difference', () => {
  const older = getSummary('context-older', {
    models: [{id: 'model-a', name: 'gpt-5.5'}],
    prompts: [{heading: 'Population', id: 'prompt-1'}],
  })
  const current = getSummary('context-current', {
    models: [
      {id: 'model-a', name: 'gpt-5.5'},
      {id: 'model-c', name: 'claude'},
    ],
    prompts: [
      {heading: 'Population', id: 'prompt-1'},
      {heading: 'Intervention', id: 'prompt-3'},
    ],
    systemPromptVariants: ['legacy', 'screening_v1'],
  })

  expect(getComparisonJudgmentContextSummaryLines(older, current)).toEqual([
    'Models: gpt-5.5; added since: claude',
    'System prompt variants: legacy; added since: screening_v1',
    'Prompts: Population; added since: Intervention',
    'Content: title + abstract',
  ])
})

test('compares content in both directions from the server-decoded flags', () => {
  const current = getSummary('context-current')
  const older = getSummary('context-older', {
    context: {...current.context, columns: [getLlmColumn({contentKey: '1111m', useFulltext: true, useMetadata: true})]},
  })

  expect(getComparisonJudgmentContextSummaryLines(older, current).at(-1)).toBe(
    'Content: title + abstract + full text + metadata (no longer used); added since: title + abstract',
  )
})

test('compares summary-mode criteria with their dispositions, including an empty criteria list', () => {
  const current = getSummaryModeSummary('context-current', [
    {criteriaDisposition: 'include', promptHeading: 'Population', promptId: 'prompt-1'},
    {criteriaDisposition: 'include', promptHeading: 'Intervention', promptId: 'prompt-3'},
  ])
  const older = getSummaryModeSummary('context-older', [
    {criteriaDisposition: 'exclude', promptHeading: 'Population', promptId: 'prompt-1'},
  ])
  const empty = getSummaryModeSummary('context-empty', [])

  expect(getComparisonJudgmentContextSummaryLines(older, current)).toEqual([
    'Models: gpt-5.5',
    'System prompt variants: legacy',
    'Criteria: Population (exclude) (no longer used); added since: Population (include), Intervention (include)',
    'Content: title + abstract',
  ])
  expect(getComparisonJudgmentContextSummaryLines(empty, current)).toContain(
    'Criteria: none; added since: Population (include), Intervention (include)',
  )
})

test('says other settings differ only when neither direction explains the difference', () => {
  const current = getSummary('context-current')
  const older = getSummary('context-older', {
    context: {...current.context, humanJudgmentMode: 'summary', sourceProjectIds: ['project-2']},
  })

  expect(getComparisonJudgmentContextSummaryLines(older, current)).toEqual([
    'Models: gpt-5.5, model-b',
    'System prompt variants: legacy',
    'Prompts: Population, prompt-2',
    'Content: title + abstract',
    otherSettingsLine,
  ])
  expect(
    getComparisonJudgmentContextSummaryLines(getSummary('context-older', {systemPromptVariants: []}), current),
  ).not.toContain(otherSettingsLine)
})
