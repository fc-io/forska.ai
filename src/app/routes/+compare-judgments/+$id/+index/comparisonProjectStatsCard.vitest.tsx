// @vitest-environment happy-dom

import {render} from 'solid-js/web'
import {afterEach, describe, expect, test, vi} from 'vitest'

import type {
  ComparisonProjectJudgmentsColumn,
  ComparisonProjectStats,
  ComparisonProjectStatsConflictResolutionProvenance,
} from '../../../../../services/comparisonProjectsService.ts'
import {ComparisonProjectStatsCard} from './comparisonProjectStatsCard.tsx'

const columns: ComparisonProjectJudgmentsColumn[] = [
  {
    contentLabel: null,
    id: 'human-column',
    kind: 'human',
    modelId: null,
    modelLabel: 'Human',
    promptId: 'summary',
    promptLabel: 'Summary',
    sourceProjectId: null,
    sourceProjectName: null,
  },
  {
    contentLabel: null,
    id: 'llm-column',
    kind: 'llm',
    modelId: 'model-1',
    modelLabel: 'GPT-5.5',
    promptId: 'summary',
    promptLabel: 'Summary',
    sourceProjectId: null,
    sourceProjectName: null,
  },
]

const createStats = (
  conflictResolutionProvenance: ComparisonProjectStatsConflictResolutionProvenance,
  judgmentContextId: string | null = 'context-current',
): ComparisonProjectStats => {
  const applied = conflictResolutionProvenance === 'all' || judgmentContextId !== null

  return {
    activeGeneration: 1,
    additionalProjectStats: {conflictResolutionAnswerComparisons: [], resolvedTruthComparisons: []},
    categoryBreakdowns: [],
    comparisons: [
      {
        cohensKappa: 0.5,
        columnInfo: null,
        conflictCount: 1,
        id: 'resolution-comparison',
        kind: 'llm-vs-conflict-resolution-no-fallback',
        label: 'GPT-5.5 vs Conflict resolution',
        leftColumnId: 'human-column',
        overlapCount: 4,
        rightColumnId: 'llm-column',
        sensitivity: 1,
        specificity: 0.5,
        trueConflictCount: 1,
      },
    ],
    conflictResolutionProvenance,
    conflictResolutionProvenanceScope: {
      applied,
      reason: applied ? null : 'no-active-context',
      requested: conflictResolutionProvenance,
    },
    isServingReady: true,
    judgmentContextId,
    servingStatus: 'ready',
    servingUpdatedAt: null,
  }
}

const renderCard = (props: {
  conflictResolutionEnabled: boolean
  conflictResolutionProvenance?: ComparisonProjectStatsConflictResolutionProvenance
  onConflictResolutionProvenanceChange?: (value: ComparisonProjectStatsConflictResolutionProvenance) => void
  stats: ComparisonProjectStats
}) => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const dispose = render(() => {
    return (
      <ComparisonProjectStatsCard
        columns={columns}
        conflictResolutionEnabled={props.conflictResolutionEnabled}
        conflictResolutionProvenance={props.conflictResolutionProvenance ?? 'all'}
        error={null}
        isError={false}
        isLoading={false}
        onConflictResolutionProvenanceChange={props.onConflictResolutionProvenanceChange}
        stats={props.stats}
      />
    )
  }, container)

  return {container, dispose}
}

const getToggle = (container: HTMLElement) => {
  return container.querySelector<HTMLInputElement>('input[type="checkbox"]')
}

describe('ComparisonProjectStatsCard', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  test('hides the current prompts toggle when conflict resolution is disabled', () => {
    const {container, dispose} = renderCard({conflictResolutionEnabled: false, stats: createStats('all')})

    try {
      expect(getToggle(container)).toBeNull()
      expect(container.textContent).not.toContain('Only resolutions made under the current prompts')
    } finally {
      dispose()
    }
  })

  test('sends the current scope when the toggle is checked and keeps all-resolution labels until it applies', () => {
    const onConflictResolutionProvenanceChange = vi.fn()
    const {container, dispose} = renderCard({
      conflictResolutionEnabled: true,
      onConflictResolutionProvenanceChange,
      stats: createStats('all'),
    })

    try {
      const toggle = getToggle(container)

      expect(toggle?.checked).toBe(false)
      expect(container.textContent).toContain('Only resolutions made under the current prompts')
      expect(container.textContent).toContain('Conflict resolution (no fallback)')
      expect(container.textContent).not.toContain('under the current prompts (no fallback)')
      expect(container.textContent).not.toContain('Conflict resolution comparisons below use only')

      toggle?.click()

      expect(onConflictResolutionProvenanceChange).toHaveBeenCalledWith('current')
    } finally {
      dispose()
    }
  })

  test('labels resolution comparisons when the stats are scoped to the current prompts', () => {
    const onConflictResolutionProvenanceChange = vi.fn()
    const {container, dispose} = renderCard({
      conflictResolutionEnabled: true,
      conflictResolutionProvenance: 'current',
      onConflictResolutionProvenanceChange,
      stats: createStats('current'),
    })

    try {
      expect(getToggle(container)?.checked).toBe(true)
      expect(container.textContent).toContain('Conflict resolution under the current prompts (no fallback)')
      expect(container.textContent).toContain(
        'Conflict resolution comparisons below use only resolutions made under the current prompts.',
      )
      expect(container.textContent).toContain('Conflict resolution stats by answer (current prompts only)')
      expect(container.textContent).not.toContain('Current prompts are not known')

      getToggle(container)?.click()

      expect(onConflictResolutionProvenanceChange).toHaveBeenCalledWith('all')
    } finally {
      dispose()
    }
  })

  test('keeps the checkbox on and shows all-resolution labels when the server could not apply the current scope', () => {
    const {container, dispose} = renderCard({
      conflictResolutionEnabled: true,
      conflictResolutionProvenance: 'current',
      stats: createStats('current', null),
    })

    try {
      expect(getToggle(container)?.checked).toBe(true)
      expect(container.textContent).toContain(
        'Current prompts are not known for this generation yet; showing all resolutions',
      )
      expect(container.textContent).toContain('Conflict resolution (no fallback)')
      expect(container.textContent).not.toContain('under the current prompts (no fallback)')
      expect(container.textContent).not.toContain('Conflict resolution comparisons below use only')
      expect(container.textContent).not.toContain('(current prompts only)')
    } finally {
      dispose()
    }
  })
})
