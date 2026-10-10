// @vitest-environment happy-dom

import {format} from 'date-fns'
import {createSignal, untrack} from 'solid-js'
import {render} from 'solid-js/web'
import {afterEach, describe, expect, test, vi} from 'vitest'

import type {
  ComparisonJudgmentContextSummary,
  ComparisonProjectJudgmentsRow,
} from '../../../services/comparisonProjectsService.ts'
import type {ComparisonJudgmentContextSummariesById} from '../../../utils/comparisonJudgmentContextSummary.ts'
import {
  ComparisonProjectJudgmentsTable,
  type ComparisonProjectJudgmentsTableColumn,
} from './comparisonProjectJudgmentsTable.tsx'

vi.mock('@tanstack/solid-router', () => {
  return {
    Link: (props: {children?: unknown; class?: string; params?: Record<string, string>; to: string}) => {
      return (
        <a class={props.class} href={props.to}>
          {props.children}
        </a>
      )
    },
  }
})

const columns: ComparisonProjectJudgmentsTableColumn[] = [
  {
    contentKey: null,
    contentLabel: null,
    id: 'llm:model-1:prompt-1',
    kind: 'llm',
    modelId: 'model-1',
    modelLabel: 'Model 1',
    promptId: 'prompt-1',
    promptLabel: 'Prompt 1',
    sourceProjectId: null,
    sourceProjectName: null,
  },
  {
    contentKey: null,
    contentLabel: null,
    id: 'llm:model-2:prompt-1',
    kind: 'llm',
    modelId: 'model-2',
    modelLabel: 'Model 2',
    promptId: 'prompt-1',
    promptLabel: 'Prompt 1',
    sourceProjectId: null,
    sourceProjectName: null,
  },
]

const getConflictRow = (overrides: Partial<ComparisonProjectJudgmentsRow> = {}): ComparisonProjectJudgmentsRow => {
  return {
    articleCreatedAt: new Date('2026-09-03T00:00:00.000Z'),
    articleExternalId: null,
    articleSummary: null,
    articleTitle: 'Chinese conflict article',
    canonicalArticleId: 'article-chinese-1',
    cells: {'llm:model-1:prompt-1': 'yes', 'llm:model-2:prompt-1': 'no'},
    conflictResolution: null,
    hasConflict: true,
    id: 'article-chinese-1',
    ...overrides,
  }
}

const getResolution = (
  articleId: string,
  value: string,
): NonNullable<ComparisonProjectJudgmentsRow['conflictResolution']> => {
  return {
    articleId,
    label: value,
    provenance: null,
    provenanceMatchesCurrent: null,
    reviewer: {displayName: 'Reviewer', userId: 'reviewer-1'},
    reviewerDisplayName: 'Reviewer',
    reviewerUserId: 'reviewer-1',
    value,
  }
}

const getContextSummary = (
  id: string,
  overrides: Partial<ComparisonJudgmentContextSummary> = {},
): ComparisonJudgmentContextSummary => {
  return {
    context: {columns: [], humanJudgmentMode: 'summary', sourceProjectIds: [], summarySourceProjectId: null, v: 1},
    createdAt: null,
    id,
    modelIds: ['model-current'],
    models: [{id: 'model-current', name: 'gpt-5.5'}],
    promptIds: ['prompt-population-v2'],
    prompts: [
      {heading: 'Population', id: 'prompt-population-v2'},
      {heading: null, id: 'summary'},
    ],
    systemPromptVariants: ['screening_v1'],
    ...overrides,
  }
}

const currentContext = getContextSummary('context-current')
const olderContext = getContextSummary('context-older', {
  modelIds: ['model-old'],
  models: [{id: 'model-old', name: 'gpt-5'}],
  promptIds: ['prompt-population-v1'],
  prompts: [{heading: 'Population', id: 'prompt-population-v1'}],
  systemPromptVariants: ['legacy'],
})

const getProvenanceResolution = (
  overrides: Partial<NonNullable<ComparisonProjectJudgmentsRow['conflictResolution']>>,
): NonNullable<ComparisonProjectJudgmentsRow['conflictResolution']> => {
  return {...getResolution('article-chinese-1', 'yes'), ...overrides}
}

const renderTable = (props: {
  conflictResolutionPendingArticleIds?: string[]
  currentJudgmentContext?: ComparisonJudgmentContextSummary | null
  judgmentContextsById?: ComparisonJudgmentContextSummariesById
  onConflictResolutionReset?: (articleId: string) => void
  onConflictResolutionSelect?: (articleId: string, value: string) => void
  rows?: ComparisonProjectJudgmentsRow[]
}) => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const dispose = render(() => {
    return (
      <ComparisonProjectJudgmentsTable
        columns={columns}
        conflictResolutionEnabled={true}
        conflictResolutionOptions={[
          {label: 'yes', value: 'yes'},
          {label: 'no', value: 'no'},
          {label: 'maybe', value: 'maybe'},
        ]}
        conflictResolutionPendingArticleIds={props.conflictResolutionPendingArticleIds}
        currentJudgmentContext={props.currentJudgmentContext}
        judgmentContextsById={props.judgmentContextsById}
        rows={props.rows ?? [getConflictRow()]}
        onConflictResolutionReset={props.onConflictResolutionReset}
        onConflictResolutionSelect={props.onConflictResolutionSelect}
      />
    )
  }, container)

  return {container, dispose}
}

describe('ComparisonProjectJudgmentsTable', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  test('keeps unresolved conflict rows on the placeholder option', async () => {
    const onConflictResolutionSelect = vi.fn()
    const {container, dispose} = renderTable({onConflictResolutionSelect})

    try {
      await Promise.resolve()
      const select = container.querySelector<HTMLSelectElement>(
        'select[aria-label="Conflict resolution for Chinese conflict article"]',
      )

      expect(select).not.toBeNull()
      if (!select) {
        throw new Error('Missing conflict resolution select')
      }

      expect(select.value).toBe('')
      expect(select.selectedOptions[0]?.textContent?.trim()).toBe('Conflict resolution:')
      expect(onConflictResolutionSelect).not.toHaveBeenCalled()
    } finally {
      dispose()
    }
  })

  test('allows changing an existing maybe conflict resolution to yes', async () => {
    const onConflictResolutionSelect = vi.fn()
    const {container, dispose} = renderTable({
      rows: [getConflictRow({conflictResolution: getResolution('article-chinese-1', 'maybe')})],
      onConflictResolutionSelect,
    })

    try {
      await Promise.resolve()
      const select = container.querySelector<HTMLSelectElement>(
        'select[aria-label="Conflict resolution for Chinese conflict article"]',
      )

      expect(select).not.toBeNull()
      if (!select) {
        throw new Error('Missing conflict resolution select')
      }

      expect(select.value).toBe('maybe')

      select.value = 'yes'
      select.dispatchEvent(new Event('change', {bubbles: true}))

      expect(onConflictResolutionSelect).toHaveBeenCalledWith('article-chinese-1', 'yes')
    } finally {
      dispose()
    }
  })

  test.each([null, 'maybe'])('keeps the select mounted after an optimistic update from %s', async (initialValue) => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const [rows, setRows] = createSignal([
      getConflictRow({conflictResolution: initialValue ? getResolution('article-chinese-1', initialValue) : null}),
    ])
    const dispose = render(() => {
      return (
        <ComparisonProjectJudgmentsTable
          columns={columns}
          conflictResolutionEnabled={true}
          conflictResolutionOptions={[
            {label: 'yes', value: 'yes'},
            {label: 'no', value: 'no'},
            {label: 'maybe', value: 'maybe'},
          ]}
          rows={rows()}
          onConflictResolutionSelect={(articleId, value) => {
            setRows((currentRows) => {
              return currentRows.map((row) => {
                return row.canonicalArticleId === articleId
                  ? {...row, conflictResolution: getResolution(articleId, value)}
                  : row
              })
            })
          }}
        />
      )
    }, container)

    try {
      await Promise.resolve()
      const select = container.querySelector<HTMLSelectElement>(
        'select[aria-label="Conflict resolution for Chinese conflict article"]',
      )

      expect(select).not.toBeNull()
      if (!select) {
        throw new Error('Missing conflict resolution select')
      }

      select.value = 'yes'
      select.dispatchEvent(new Event('change', {bubbles: true}))
      await Promise.resolve()

      expect(container.querySelector('select')).toBe(select)
      expect(select.isConnected).toBe(true)
      expect(select.value).toBe('yes')
    } finally {
      dispose()
    }
  })

  test('keeps conflict resolution changes scoped to the selected row after rerender', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const [rows, setRows] = createSignal([
      getConflictRow({
        articleTitle: 'Chinese conflict article 1',
        canonicalArticleId: 'article-chinese-1',
        conflictResolution: getResolution('article-chinese-1', 'maybe'),
        id: 'article-chinese-1',
      }),
      getConflictRow({
        articleTitle: 'Chinese conflict article 2',
        canonicalArticleId: 'article-chinese-2',
        conflictResolution: getResolution('article-chinese-2', 'no'),
        id: 'article-chinese-2',
      }),
      getConflictRow({
        articleTitle: 'Chinese conflict article 3',
        canonicalArticleId: 'article-chinese-3',
        conflictResolution: null,
        id: 'article-chinese-3',
      }),
    ])
    const dispose = render(() => {
      return (
        <ComparisonProjectJudgmentsTable
          columns={columns}
          conflictResolutionEnabled={true}
          conflictResolutionOptions={[
            {label: 'yes', value: 'yes'},
            {label: 'no', value: 'no'},
            {label: 'maybe', value: 'maybe'},
          ]}
          rows={rows()}
          onConflictResolutionSelect={(articleId, value) => {
            setRows((currentRows) => {
              return currentRows.map((row) => {
                return row.canonicalArticleId === articleId
                  ? {...row, conflictResolution: getResolution(articleId, value)}
                  : {...row}
              })
            })
          }}
        />
      )
    }, container)

    try {
      await Promise.resolve()
      const selects = Array.from(container.querySelectorAll<HTMLSelectElement>('select'))

      expect(
        selects.map((select) => {
          return select.value
        }),
      ).toEqual(['maybe', 'no', ''])

      selects[0].value = 'yes'
      selects[0].dispatchEvent(new Event('change', {bubbles: true}))
      await Promise.resolve()

      expect(
        Array.from(container.querySelectorAll<HTMLSelectElement>('select')).map((select) => {
          return select.value
        }),
      ).toEqual(['yes', 'no', ''])
      expect(Array.from(container.querySelectorAll('select'))).toEqual(selects)

      setRows((currentRows) => {
        return [...currentRows].reverse().map((row) => {
          return {...row, articleTitle: `${row.articleTitle} updated`}
        })
      })
      await Promise.resolve()

      expect(Array.from(container.querySelectorAll('select'))).toEqual([...selects].reverse())
      expect(selects[0].getAttribute('aria-label')).toContain('article 1 updated')
      selects[0].value = 'no'
      selects[0].dispatchEvent(new Event('change', {bubbles: true}))
      expect(
        untrack(rows).find((row) => {
          return row.id === 'article-chinese-1'
        })?.conflictResolution?.value,
      ).toBe('no')

      setRows((currentRows) => {
        return currentRows.slice(1)
      })
      await Promise.resolve()
      expect(Array.from(container.querySelectorAll('select'))).toEqual([selects[1], selects[0]])
    } finally {
      dispose()
    }
  })

  test('disables only rows whose conflict-resolution save is pending', async () => {
    const {container, dispose} = renderTable({
      conflictResolutionPendingArticleIds: ['article-chinese-2'],
      rows: [
        getConflictRow({
          articleTitle: 'Chinese conflict article 1',
          canonicalArticleId: 'article-chinese-1',
          conflictResolution: getResolution('article-chinese-1', 'maybe'),
          id: 'article-chinese-1',
        }),
        getConflictRow({
          articleTitle: 'Chinese conflict article 2',
          canonicalArticleId: 'article-chinese-2',
          conflictResolution: getResolution('article-chinese-2', 'no'),
          id: 'article-chinese-2',
        }),
      ],
    })

    try {
      await Promise.resolve()
      const selects = Array.from(container.querySelectorAll<HTMLSelectElement>('select'))

      expect(selects).toHaveLength(2)
      expect(selects[0]?.disabled).toBe(false)
      expect(selects[1]?.disabled).toBe(true)
    } finally {
      dispose()
    }
  })
  test('shows the reviewer, set time and an older prompts badge with the context in its tooltip', async () => {
    const setAt = '2026-10-09T08:15:00.000Z'
    const {container, dispose} = renderTable({
      currentJudgmentContext: currentContext,
      judgmentContextsById: {'context-current': currentContext, 'context-older': olderContext},
      rows: [
        getConflictRow({
          conflictResolution: getProvenanceResolution({
            provenance: {contextId: 'context-older', generation: 3, origin: 'ui', setAt},
            provenanceMatchesCurrent: false,
            reviewer: {displayName: 'Anna Berg', userId: 'local-1'},
            reviewerDisplayName: 'Anna Berg',
          }),
        }),
      ],
    })

    try {
      await Promise.resolve()
      const cellText = container.querySelector('td:nth-child(2)')?.textContent ?? ''
      const provenance = container.querySelector('td:nth-child(2) [title]:not(button)')

      expect(cellText).toContain(`Anna Berg · ${format(new Date(setAt), 'yyyy-MM-dd HH:mm')}`)
      expect(cellText).toContain('Older prompts')
      expect(provenance?.getAttribute('title')).toBe(
        [
          'Resolved under older prompts',
          'Models: gpt-5 (not current)',
          'System prompt variants: legacy (not current)',
          'Prompts: Population (not current)',
          'Content: none',
        ].join('\n'),
      )
      expect(container.querySelector<HTMLSelectElement>('select')?.value).toBe('yes')
    } finally {
      dispose()
    }
  })

  test.each([true, null])('shows no older prompts badge when the match is %s', async (provenanceMatchesCurrent) => {
    const {container, dispose} = renderTable({
      currentJudgmentContext: currentContext,
      judgmentContextsById: {'context-current': currentContext},
      rows: [
        getConflictRow({
          conflictResolution: getProvenanceResolution({
            provenance: {
              contextId: provenanceMatchesCurrent ? 'context-current' : null,
              generation: 4,
              origin: 'ui',
              setAt: '2026-10-10T10:00:00.000Z',
            },
            provenanceMatchesCurrent,
          }),
        }),
      ],
    })

    try {
      await Promise.resolve()
      const cellText = container.querySelector('td:nth-child(2)')?.textContent ?? ''

      expect(cellText).toContain(`Reviewer · ${format(new Date('2026-10-10T10:00:00.000Z'), 'yyyy-MM-dd HH:mm')}`)
      expect(cellText).not.toContain('Older prompts')
    } finally {
      dispose()
    }
  })

  test('labels imported resolutions with their import time and renders old rows without provenance', async () => {
    const {container, dispose} = renderTable({
      rows: [
        getConflictRow({
          articleTitle: 'Imported article',
          canonicalArticleId: 'article-imported',
          conflictResolution: getProvenanceResolution({
            provenance: {contextId: null, generation: null, origin: 'file-import', setAt: '2026-10-10T10:00:00.000Z'},
            reviewer: null,
            reviewerDisplayName: null,
            reviewerUserId: null,
          }),
          id: 'article-imported',
        }),
        getConflictRow({
          articleTitle: 'Old article',
          canonicalArticleId: 'article-old',
          conflictResolution: getProvenanceResolution({
            reviewer: null,
            reviewerDisplayName: null,
            reviewerUserId: null,
          }),
          id: 'article-old',
        }),
      ],
    })

    try {
      await Promise.resolve()
      const cells = Array.from(container.querySelectorAll('tbody tr')).map((row) => {
        return row.querySelector('td:nth-child(2)')
      })

      expect(cells[0]?.textContent).toContain(
        `imported ${format(new Date('2026-10-10T10:00:00.000Z'), 'yyyy-MM-dd HH:mm')}`,
      )
      expect(cells[0]?.textContent).not.toContain('Older prompts')
      expect(cells[1]?.querySelector('p')).toBeNull()
      expect(cells[1]?.querySelectorAll('select')).toHaveLength(1)
      expect(cells[1]?.querySelector('button[title="Reset conflict resolution"]')).not.toBeNull()
    } finally {
      dispose()
    }
  })
})
