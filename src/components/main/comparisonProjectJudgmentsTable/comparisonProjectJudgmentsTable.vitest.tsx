// @vitest-environment happy-dom

import {createSignal} from 'solid-js'
import {render} from 'solid-js/web'
import {afterEach, describe, expect, test, vi} from 'vitest'

import type {ComparisonProjectJudgmentsRow} from '../../../services/comparisonProjectsService.ts'
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
  return {articleId, label: value, reviewerDisplayName: 'Reviewer', reviewerUserId: 'reviewer-1', value}
}

const renderTable = (props: {
  conflictResolutionPendingArticleIds?: string[]
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
      rows: [
        getConflictRow({
          conflictResolution: {
            articleId: 'article-chinese-1',
            label: 'maybe',
            reviewerDisplayName: 'Reviewer',
            reviewerUserId: 'reviewer-1',
            value: 'maybe',
          },
        }),
      ],
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

  test('keeps the newly selected conflict resolution after an optimistic parent update', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const [rows, setRows] = createSignal([
      getConflictRow({
        conflictResolution: {
          articleId: 'article-chinese-1',
          label: 'maybe',
          reviewerDisplayName: 'Reviewer',
          reviewerUserId: 'reviewer-1',
          value: 'maybe',
        },
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
                  ? {
                      ...row,
                      conflictResolution: {
                        articleId,
                        label: value,
                        reviewerDisplayName: 'Reviewer',
                        reviewerUserId: 'reviewer-1',
                        value,
                      },
                    }
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
})
