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
    criteriaDisposition: null,
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

test('collects the distinct context ids of a page in sorted order', () => {
  expect(
    getComparisonJudgmentContextIds([
      getRow('a', 'context-b'),
      getRow('b', null),
      getRow('c', undefined),
      getRow('d', 'context-a'),
      getRow('e', 'context-b'),
    ]),
  ).toEqual(['context-a', 'context-b'])
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

test('summarizes models, variants, prompt headings and content without the summary column', () => {
  expect(getComparisonJudgmentContextSummaryLines(getSummary('context-1'))).toEqual([
    'Models: gpt-5.5, model-b',
    'System prompt variants: legacy',
    'Prompts: Population, prompt-2',
    'Content: title + abstract',
  ])
})

test('marks entries that the current context no longer uses', () => {
  const current = getSummary('context-current', {
    models: [{id: 'model-a', name: 'gpt-5.5'}],
    prompts: [{heading: 'Population', id: 'prompt-1-v2'}],
    systemPromptVariants: ['legacy'],
  })
  const older = getSummary('context-older', {
    models: [{id: 'model-a', name: 'gpt-5.5'}],
    prompts: [{heading: 'Population', id: 'prompt-1'}],
    systemPromptVariants: [],
  })

  expect(getComparisonJudgmentContextSummaryLines(older, current)).toEqual([
    'Models: gpt-5.5',
    'System prompt variants: none',
    'Prompts: Population (not current)',
    'Content: title + abstract',
  ])
  expect(getComparisonJudgmentContextSummaryLines(current, current)).toEqual([
    'Models: gpt-5.5',
    'System prompt variants: legacy',
    'Prompts: Population',
    'Content: title + abstract',
  ])
})

test('marks a content-only difference on the content line', () => {
  const current = getSummary('context-current')
  const older = getSummary('context-older', {
    context: {...current.context, columns: [getLlmColumn({useFulltext: true, useMetadata: true})]},
  })

  expect(getComparisonJudgmentContextSummaryLines(older, current).at(-1)).toBe(
    'Content: title + abstract + full text + metadata (not current)',
  )
})

test('says other settings differ when no listed entry explains the difference', () => {
  const current = getSummary('context-current')
  const older = getSummary('context-older', {
    context: {...current.context, columns: [getLlmColumn({criteriaDisposition: 'exclude'})]},
  })

  expect(getComparisonJudgmentContextSummaryLines(older, current)).toEqual([
    'Models: gpt-5.5, model-b',
    'System prompt variants: legacy',
    'Prompts: Population, prompt-2',
    'Content: title + abstract',
    'Other settings differ from the current prompts (criteria dispositions, source projects or human judgment mode)',
  ])
})
