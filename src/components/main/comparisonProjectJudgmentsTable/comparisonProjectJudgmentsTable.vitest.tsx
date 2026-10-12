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
    conflictComment: null,
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
    setAt: null,
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

const getConflictComment = (
  comment: string,
  overrides: Partial<NonNullable<ComparisonProjectJudgmentsRow['conflictComment']>> = {},
): NonNullable<ComparisonProjectJudgmentsRow['conflictComment']> => {
  return {author: null, comment, updatedAt: null, ...overrides}
}

const conflictResolutionOptions = [
  {label: 'yes', value: 'yes'},
  {label: 'no', value: 'no'},
  {label: 'maybe', value: 'maybe'},
]

const renderTable = (props: {
  conflictResolutionOptions?: Array<{label: string; value: string}>
  conflictResolutionPendingArticleIds?: string[]
  currentJudgmentContext?: ComparisonJudgmentContextSummary | null
  judgmentContextsById?: ComparisonJudgmentContextSummariesById
  onConflictResolutionCommentSave?: (articleId: string, comment: string | null) => boolean | Promise<boolean>
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
        conflictResolutionOptions={props.conflictResolutionOptions ?? conflictResolutionOptions}
        conflictResolutionPendingArticleIds={props.conflictResolutionPendingArticleIds}
        currentJudgmentContext={props.currentJudgmentContext}
        judgmentContextsById={props.judgmentContextsById}
        rows={props.rows ?? [getConflictRow()]}
        onConflictResolutionCommentSave={props.onConflictResolutionCommentSave}
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

  test('shows a stored resolution on a row without a current conflict and lets it be changed or reset', async () => {
    const onConflictResolutionReset = vi.fn()
    const onConflictResolutionSelect = vi.fn()
    const {container, dispose} = renderTable({
      rows: [
        getConflictRow({
          cells: {'llm:model-1:prompt-1': 'no', 'llm:model-2:prompt-1': 'no'},
          conflictResolution: getResolution('article-chinese-1', 'yes'),
          hasConflict: false,
        }),
      ],
      onConflictResolutionReset,
      onConflictResolutionSelect,
    })

    try {
      await Promise.resolve()
      const select = container.querySelector<HTMLSelectElement>(
        'select[aria-label="Conflict resolution for Chinese conflict article"]',
      )
      const resetButton = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Reset conflict resolution for Chinese conflict article"]',
      )

      expect(select?.value).toBe('yes')
      expect(container.textContent).toContain('No current conflict')
      expect(container.textContent).not.toContain('No conflict')

      if (!select || !resetButton) {
        throw new Error('Missing conflict resolution controls')
      }

      select.value = 'no'
      select.dispatchEvent(new Event('change', {bubbles: true}))
      resetButton.click()

      expect(onConflictResolutionSelect).toHaveBeenCalledWith('article-chinese-1', 'no')
      expect(onConflictResolutionReset).toHaveBeenCalledWith('article-chinese-1')
    } finally {
      dispose()
    }
  })

  test('shows a stored resolution without a current conflict when no options are available', async () => {
    const {container, dispose} = renderTable({
      conflictResolutionOptions: [],
      rows: [getConflictRow({conflictResolution: getResolution('article-chinese-1', 'yes'), hasConflict: false})],
    })

    try {
      await Promise.resolve()

      expect(container.querySelector('span[title="yes"]')?.textContent).toBe('yes')
      expect(container.textContent).toContain('No current conflict')
    } finally {
      dispose()
    }
  })

  test('offers no resolution control on rows with neither a conflict nor a stored resolution', async () => {
    const {container, dispose} = renderTable({rows: [getConflictRow({hasConflict: false})]})

    try {
      await Promise.resolve()

      expect(container.querySelector('select')).toBeNull()
      expect(container.textContent).toContain('No conflict')
      expect(container.textContent).not.toContain('No current conflict')
    } finally {
      dispose()
    }
  })

  test('shows no hint that the conflict is gone on rows with a current conflict', async () => {
    const {container, dispose} = renderTable({
      rows: [getConflictRow({conflictResolution: getResolution('article-chinese-1', 'yes')})],
    })

    try {
      await Promise.resolve()

      expect(container.querySelector('select')).not.toBeNull()
      expect(container.textContent).not.toContain('No current conflict')
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
            setAt,
          }),
        }),
      ],
    })

    try {
      await Promise.resolve()
      const cellText = container.querySelector('td:nth-child(2)')?.textContent ?? ''
      const provenance = container.querySelector('td:nth-child(2) [title]:not(button)')

      expect(cellText).toContain(`Anna Berg · ${format(new Date(setAt), 'yyyy-MM-dd HH:mm')}`)
      expect(cellText).not.toContain('before tracking')
      expect(cellText).toContain('Older prompts')
      expect(provenance?.getAttribute('title')).toBe(
        [
          'Resolved under older prompts',
          'Models: gpt-5 (no longer used); added since: gpt-5.5',
          'System prompt variants: legacy (no longer used); added since: screening_v1',
          'Prompts: Population (no longer used); added since: Population',
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
            setAt: '2026-10-10T10:00:00.000Z',
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

  test('marks a pre-tracking reviewer and shows the stored set time for rows without provenance', async () => {
    const setAt = '2026-09-01T09:30:00.000Z'
    const {container, dispose} = renderTable({
      currentJudgmentContext: currentContext,
      rows: [
        getConflictRow({
          conflictResolution: getProvenanceResolution({
            provenance: null,
            provenanceMatchesCurrent: null,
            reviewer: {displayName: 'Fredrik', userId: 'local-1'},
            reviewerDisplayName: 'Fredrik',
            setAt,
          }),
        }),
      ],
    })

    try {
      await Promise.resolve()
      const line = container.querySelector('td:nth-child(2) p')
      const provenance = container.querySelector('td:nth-child(2) [title]:not(button)')

      expect(line?.textContent).toBe(`Fredrik (before tracking) · ${format(new Date(setAt), 'yyyy-MM-dd HH:mm')}`)
      expect(line?.querySelector('span')?.textContent).toBe('(before tracking)')
      expect(provenance?.getAttribute('title')).toContain('Resolved before prompt tracking')
      expect(container.querySelector('td:nth-child(2)')?.textContent).not.toContain('Older prompts')
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
            setAt: '2026-10-10T10:00:00.000Z',
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
        getConflictRow({
          articleTitle: 'Old timed article',
          canonicalArticleId: 'article-old-timed',
          conflictResolution: getProvenanceResolution({
            reviewer: null,
            reviewerDisplayName: null,
            reviewerUserId: null,
            setAt: '2026-08-01T12:00:00.000Z',
          }),
          id: 'article-old-timed',
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
      expect(cells[2]?.querySelector('p')?.textContent).toBe(
        format(new Date('2026-08-01T12:00:00.000Z'), 'yyyy-MM-dd HH:mm'),
      )
    } finally {
      dispose()
    }
  })
})

const waitForUpdates = () => {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
}

const getCommentButton = (container: HTMLElement) => {
  const button = container.querySelector<HTMLButtonElement>('button[aria-label*="comment on the conflict for"]')

  if (!button) {
    throw new Error('Missing conflict comment button')
  }

  return button
}

const getCommentTextarea = () => {
  const textarea = document.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Comment for Chinese conflict article"]',
  )

  if (!textarea) {
    throw new Error('Missing conflict comment textarea')
  }

  return textarea
}

const getPopoverButton = (label: string) => {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).find(
    (candidate) => {
      return candidate.textContent?.trim() === label
    },
  )

  if (!button) {
    throw new Error(`Missing ${label} button`)
  }

  return button
}

const getIsCommentPopoverOpen = (container: HTMLElement) => {
  return getCommentButton(container).getAttribute('aria-expanded') === 'true'
}

const typeComment = (textarea: HTMLTextAreaElement, value: string) => {
  textarea.value = value
  textarea.dispatchEvent(new InputEvent('input', {bubbles: true}))
}

const openCommentPopover = async (container: HTMLElement) => {
  getCommentButton(container).click()
  await waitForUpdates()

  return getCommentTextarea()
}

describe('ComparisonProjectJudgmentsTable conflict comment', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  test('enables the comment icon on a conflicting row without a resolution and saves through it', async () => {
    const onConflictResolutionCommentSave = vi.fn(() => {
      return true
    })
    const {container, dispose} = renderTable({onConflictResolutionCommentSave})

    try {
      await Promise.resolve()
      const button = getCommentButton(container)

      expect(container.querySelector<HTMLSelectElement>('select')?.value).toBe('')
      expect(button.disabled).toBe(false)
      expect(button.title).toBe('Add comment')
      expect(button.getAttribute('aria-label')).toBe('Add comment on the conflict for Chinese conflict article')
      expect(button.dataset.hasComment).toBe('false')

      const textarea = await openCommentPopover(container)

      expect(textarea.disabled).toBe(false)
      typeComment(textarea, 'Waiting for the full text')
      getPopoverButton('Save').click()
      await waitForUpdates()

      expect(onConflictResolutionCommentSave).toHaveBeenCalledWith('article-chinese-1', 'Waiting for the full text')
    } finally {
      dispose()
    }
  })

  test('shows the comment icon on a conflicting row when no options are available', async () => {
    const {container, dispose} = renderTable({conflictResolutionOptions: []})

    try {
      await Promise.resolve()
      const button = getCommentButton(container)

      expect(container.textContent).toContain('No options available')
      expect(button.disabled).toBe(false)
      expect(button.title).toBe('Add comment')
    } finally {
      dispose()
    }
  })

  test('marks a comment-only row without a conflict or resolution and lets it be edited', async () => {
    const onConflictResolutionCommentSave = vi.fn(() => {
      return true
    })
    const {container, dispose} = renderTable({
      onConflictResolutionCommentSave,
      rows: [
        getConflictRow({
          cells: {'llm:model-1:prompt-1': 'no', 'llm:model-2:prompt-1': 'no'},
          conflictComment: getConflictComment('Agreed after the rebuild'),
          hasConflict: false,
        }),
        getConflictRow({
          articleTitle: 'Agreed article',
          canonicalArticleId: 'article-2',
          cells: {'llm:model-1:prompt-1': 'no', 'llm:model-2:prompt-1': 'no'},
          hasConflict: false,
          id: 'article-2',
        }),
      ],
    })

    try {
      await Promise.resolve()
      const buttons = container.querySelectorAll<HTMLButtonElement>('button[aria-label*="comment on the conflict for"]')
      const button = getCommentButton(container)

      expect(buttons).toHaveLength(1)
      expect(container.querySelector('select')).toBeNull()
      expect(container.textContent).toContain('No current conflict')
      expect(container.textContent).toContain('No conflict')
      expect(button.disabled).toBe(false)
      expect(button.dataset.hasComment).toBe('true')
      expect(button.title).toBe('Agreed after the rebuild')

      const textarea = await openCommentPopover(container)

      expect(textarea.value).toBe('Agreed after the rebuild')
      getPopoverButton('Remove').click()
      await waitForUpdates()

      expect(onConflictResolutionCommentSave).toHaveBeenCalledWith('article-chinese-1', null)
    } finally {
      dispose()
    }
  })

  test('keeps the editor of a comment-only row open while its removal is pending and after it fails', async () => {
    const commentOnlyRow = getConflictRow({
      cells: {'llm:model-1:prompt-1': 'no', 'llm:model-2:prompt-1': 'no'},
      conflictComment: getConflictComment('Agreed after the rebuild'),
      hasConflict: false,
    })
    const [rows, setRows] = createSignal<ComparisonProjectJudgmentsRow[]>([commentOnlyRow])
    const [pendingArticleIds, setPendingArticleIds] = createSignal<string[]>([])
    const pendingRemove: {reject: () => void} = {reject: () => {}}
    const onConflictResolutionCommentSave = vi.fn(async () => {
      setPendingArticleIds(['article-chinese-1'])
      setRows([{...commentOnlyRow, conflictComment: null}])
      await new Promise<void>((_resolve, reject) => {
        pendingRemove.reject = () => {
          reject(new Error('Remove failed'))
        }
      }).catch(() => {
        setRows([commentOnlyRow])
        setPendingArticleIds([])
      })
      return false
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const dispose = render(() => {
      return (
        <ComparisonProjectJudgmentsTable
          columns={columns}
          conflictResolutionEnabled={true}
          conflictResolutionOptions={conflictResolutionOptions}
          conflictResolutionPendingArticleIds={pendingArticleIds()}
          rows={rows()}
          onConflictResolutionCommentSave={onConflictResolutionCommentSave}
        />
      )
    }, container)

    try {
      await Promise.resolve()
      await openCommentPopover(container)
      getPopoverButton('Remove').click()
      await waitForUpdates()

      expect(onConflictResolutionCommentSave).toHaveBeenCalledWith('article-chinese-1', null)
      expect(container.textContent).toContain('No current conflict')
      expect(getIsCommentPopoverOpen(container)).toBe(true)
      expect(getCommentButton(container).disabled).toBe(true)

      pendingRemove.reject()
      await waitForUpdates()

      expect(getIsCommentPopoverOpen(container)).toBe(true)
      expect(getCommentButton(container).disabled).toBe(false)
      expect(getCommentButton(container).dataset.hasComment).toBe('true')
      expect(getCommentTextarea().value).toBe('Agreed after the rebuild')
    } finally {
      dispose()
    }
  })

  test('shows the author name of a comment without an author user id', async () => {
    const {container, dispose} = renderTable({
      rows: [
        getConflictRow({
          conflictComment: getConflictComment('Imported note', {
            author: {displayName: 'Dr Import', userId: null},
            updatedAt: '2026-10-10T09:30:00.000Z',
          }),
        }),
      ],
    })

    try {
      await Promise.resolve()

      expect(getCommentButton(container).title).toBe(
        `Imported note\nComment by Dr Import, ${format(new Date('2026-10-10T09:30:00.000Z'), 'yyyy-MM-dd HH:mm')}`,
      )
    } finally {
      dispose()
    }
  })

  test('marks the icon when a comment exists and shows it as the tooltip', async () => {
    const {container, dispose} = renderTable({
      rows: [
        getConflictRow({
          conflictComment: getConflictComment('Population unclear in abstract', {
            author: {displayName: 'Dr Comment', userId: 'local-user'},
            updatedAt: '2026-10-10T09:30:00.000Z',
          }),
          conflictResolution: getProvenanceResolution({}),
        }),
        getConflictRow({
          articleTitle: 'Second article',
          canonicalArticleId: 'article-2',
          conflictResolution: getProvenanceResolution({articleId: 'article-2'}),
          id: 'article-2',
        }),
      ],
    })

    try {
      await Promise.resolve()
      const [commentedButton, emptyButton] = Array.from(
        container.querySelectorAll<HTMLButtonElement>('button[aria-label*="comment on the conflict for"]'),
      )

      expect(commentedButton?.disabled).toBe(false)
      expect(commentedButton?.dataset.hasComment).toBe('true')
      expect(commentedButton?.title).toBe(
        `Population unclear in abstract\nComment by Dr Comment, ${format(new Date('2026-10-10T09:30:00.000Z'), 'yyyy-MM-dd HH:mm')}`,
      )
      expect(commentedButton?.querySelector('svg')?.getAttribute('fill')).toBe('currentColor')
      expect(emptyButton?.dataset.hasComment).toBe('false')
      expect(emptyButton?.title).toBe('Add comment')
      expect(emptyButton?.querySelector('svg')?.getAttribute('fill')).toBe('none')
    } finally {
      dispose()
    }
  })

  test('opens an editor with the comment and saves the trimmed text', async () => {
    const onConflictResolutionCommentSave = vi.fn(() => {
      return true
    })
    const {container, dispose} = renderTable({
      onConflictResolutionCommentSave,
      rows: [getConflictRow({conflictComment: getConflictComment('First note')})],
    })

    try {
      await Promise.resolve()
      const textarea = await openCommentPopover(container)

      expect(getIsCommentPopoverOpen(container)).toBe(true)
      expect(document.activeElement).toBe(textarea)
      expect(textarea.value).toBe('First note')
      expect(textarea.maxLength).toBe(4000)
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain('10 / 4000')

      typeComment(textarea, '  Checked the full text\nand the protocol  ')
      getPopoverButton('Save').click()
      await waitForUpdates()

      expect(onConflictResolutionCommentSave).toHaveBeenCalledWith(
        'article-chinese-1',
        'Checked the full text\nand the protocol',
      )
      expect(getIsCommentPopoverOpen(container)).toBe(false)
    } finally {
      dispose()
    }
  })

  test('focuses the editor without scrolling the page while the popover is still unpositioned', async () => {
    const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus')
    const {container, dispose} = renderTable({
      rows: [getConflictRow({conflictComment: getConflictComment('First note')})],
    })

    try {
      await Promise.resolve()
      const textarea = await openCommentPopover(container)
      const textareaFocusCalls = focusSpy.mock.contexts
        .map((element, index) => {
          return {args: focusSpy.mock.calls[index], element}
        })
        .filter(({element}) => {
          return element === textarea
        })

      expect(document.activeElement).toBe(textarea)
      expect(textarea.hasAttribute('autofocus')).toBe(false)
      expect(textareaFocusCalls.length).toBeGreaterThan(0)
      for (const {args} of textareaFocusCalls) {
        expect(args).toEqual([{preventScroll: true}])
      }
    } finally {
      focusSpy.mockRestore()
      dispose()
    }
  })

  test('saves with Cmd/Ctrl+Enter, keeps plain Enter for new lines and closes on Escape without saving or losing the draft', async () => {
    const onConflictResolutionCommentSave = vi.fn(() => {
      return true
    })
    const {container, dispose} = renderTable({
      onConflictResolutionCommentSave,
      rows: [getConflictRow({conflictResolution: getProvenanceResolution({})})],
    })

    try {
      await Promise.resolve()
      const textarea = await openCommentPopover(container)

      typeComment(textarea, 'Draft')
      textarea.dispatchEvent(new KeyboardEvent('keydown', {bubbles: true, key: 'Enter'}))
      textarea.dispatchEvent(new KeyboardEvent('keydown', {bubbles: true, key: 'Escape'}))
      await waitForUpdates()

      expect(onConflictResolutionCommentSave).not.toHaveBeenCalled()
      expect(getIsCommentPopoverOpen(container)).toBe(false)
      expect(getCommentButton(container).dataset.hasDraft).toBe('true')

      const reopenedTextarea = await openCommentPopover(container)

      expect(reopenedTextarea.value).toBe('Draft')
      typeComment(reopenedTextarea, 'Shortcut note')
      reopenedTextarea.dispatchEvent(new KeyboardEvent('keydown', {bubbles: true, ctrlKey: true, key: 'Enter'}))
      await waitForUpdates()

      expect(onConflictResolutionCommentSave).toHaveBeenCalledWith('article-chinese-1', 'Shortcut note')
      expect(getCommentButton(container).dataset.hasDraft).toBe('false')
    } finally {
      dispose()
    }
  })

  test('removes the comment with null and keeps the editor open when the save fails', async () => {
    const onConflictResolutionCommentSave = vi.fn((_articleId: string, comment: string | null) => {
      return comment === null
    })
    const {container, dispose} = renderTable({
      onConflictResolutionCommentSave,
      rows: [getConflictRow({conflictComment: getConflictComment('Old note')})],
    })

    try {
      await Promise.resolve()
      const textarea = await openCommentPopover(container)

      typeComment(textarea, 'Rejected note')
      getPopoverButton('Save').click()
      await waitForUpdates()

      expect(getIsCommentPopoverOpen(container)).toBe(true)

      getPopoverButton('Remove').click()
      await waitForUpdates()

      expect(onConflictResolutionCommentSave).toHaveBeenLastCalledWith('article-chinese-1', null)
      expect(getIsCommentPopoverOpen(container)).toBe(false)
    } finally {
      dispose()
    }
  })

  test('disables the editor while the row is pending', async () => {
    const [pendingArticleIds, setPendingArticleIds] = createSignal<string[]>([])
    const container = document.createElement('div')
    document.body.appendChild(container)
    const dispose = render(() => {
      return (
        <ComparisonProjectJudgmentsTable
          columns={columns}
          conflictResolutionEnabled={true}
          conflictResolutionOptions={conflictResolutionOptions}
          conflictResolutionPendingArticleIds={pendingArticleIds()}
          rows={[getConflictRow({conflictComment: getConflictComment('Note')})]}
        />
      )
    }, container)

    try {
      await Promise.resolve()
      const textarea = await openCommentPopover(container)

      setPendingArticleIds(['article-chinese-1'])
      await Promise.resolve()

      expect(textarea.disabled).toBe(true)
      expect(getPopoverButton('Save').disabled).toBe(true)
      expect(getPopoverButton('Remove').disabled).toBe(true)
      expect(getCommentButton(container).disabled).toBe(true)
    } finally {
      dispose()
    }
  })

  test('shows the comment icon next to a resolution when no options are available', async () => {
    const {container, dispose} = renderTable({
      conflictResolutionOptions: [],
      rows: [
        getConflictRow({
          conflictComment: getConflictComment('Kept note'),
          conflictResolution: getProvenanceResolution({}),
        }),
      ],
    })

    try {
      await Promise.resolve()
      const button = getCommentButton(container)

      expect(container.querySelector('select')).toBeNull()
      expect(button.disabled).toBe(false)
      expect(button.title).toBe('Kept note')
      expect(button.dataset.hasComment).toBe('true')
    } finally {
      dispose()
    }
  })

  test('keeps an unsaved draft per article after an outside click, marks the icon and discards it on request', async () => {
    const onConflictResolutionCommentSave = vi.fn(() => {
      return true
    })
    const {container, dispose} = renderTable({
      onConflictResolutionCommentSave,
      rows: [getConflictRow({conflictComment: getConflictComment('Saved note')})],
    })

    try {
      await Promise.resolve()
      const textarea = await openCommentPopover(container)

      typeComment(textarea, 'Saved note, plus the protocol check')
      document.body.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true}))
      document.body.dispatchEvent(new PointerEvent('pointerup', {bubbles: true}))
      document.body.click()
      await waitForUpdates()

      const button = getCommentButton(container)

      expect(getIsCommentPopoverOpen(container)).toBe(false)
      expect(onConflictResolutionCommentSave).not.toHaveBeenCalled()
      expect(button.dataset.hasDraft).toBe('true')
      expect(button.title).toBe('Saved note\nUnsaved draft')
      expect(button.querySelector('span.rounded-full')).not.toBeNull()

      const reopenedTextarea = await openCommentPopover(container)

      expect(reopenedTextarea.value).toBe('Saved note, plus the protocol check')

      getPopoverButton('Discard').click()
      await waitForUpdates()

      expect(getIsCommentPopoverOpen(container)).toBe(false)
      expect(button.dataset.hasDraft).toBe('false')
      expect(button.title).toBe('Saved note')
      expect(button.querySelector('span.rounded-full')).toBeNull()
      expect((await openCommentPopover(container)).value).toBe('Saved note')
      expect(getPopoverButton('Discard').disabled).toBe(true)
      expect(onConflictResolutionCommentSave).not.toHaveBeenCalled()
    } finally {
      dispose()
    }
  })

  test('renders a non-string comment from a misparsed response without crashing', async () => {
    const {container, dispose} = renderTable({
      rows: [getConflictRow({conflictComment: getConflictComment(new Date('2026-10-10T00:00:00.000Z') as never)})],
    })

    try {
      await Promise.resolve()
      const button = getCommentButton(container)

      expect(button.dataset.hasComment).toBe('false')
      expect(button.title).toBe('Add comment')
      expect((await openCommentPopover(container)).value).toBe('')
    } finally {
      dispose()
    }
  })
})
