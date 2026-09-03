// @vitest-environment happy-dom

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

const renderTable = (props: {
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
})
