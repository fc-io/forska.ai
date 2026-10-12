// @vitest-environment happy-dom

import type {JSX} from 'solid-js'
import {render} from 'solid-js/web'
import {afterEach, describe, expect, test, vi} from 'vitest'

import {
  fetchComparisonProjectJudgmentsPage,
  setComparisonProjectConflictComment,
} from '../../../services/comparisonProjectsService.ts'
import {ComparisonProjectJudgmentsTable} from './comparisonProjectJudgmentsTable.tsx'

vi.mock('@tanstack/solid-router', () => {
  return {
    Link: (props: {children?: JSX.Element; class?: string; to: string}) => {
      return (
        <a class={props.class} href={props.to}>
          {props.children}
        </a>
      )
    },
  }
})

const conflictComment = {
  author: {displayName: '10/10/2026', userId: 'local-1'},
  comment: '2026-10-10',
  updatedAt: '2026-10-10T09:30:00.000Z',
}

const resolution = {
  articleId: 'article-dated',
  label: 'yes',
  provenance: {contextId: null, generation: 1, origin: 'ui', setAt: '2026-10-10T09:00:00.000Z'},
  provenanceMatchesCurrent: null,
  reviewer: {displayName: '10/10/2026', userId: 'local-1'},
  reviewerDisplayName: '10/10/2026',
  reviewerUserId: 'local-1',
  setAt: '2026-10-10T09:00:00.000Z',
  value: 'yes',
}

const page = {
  activeGeneration: 1,
  data: [
    {
      articleCreatedAt: '2026-10-01T00:00:00.000Z',
      articleExternalId: null,
      articleSummary: null,
      articleTitle: '10/10/2026',
      canonicalArticleId: 'article-dated',
      cells: {'llm:model-1:prompt-1': 'yes', 'llm:model-2:prompt-1': 'no'},
      conflictComment,
      conflictResolution: resolution,
      hasConflict: true,
      id: 'article-dated',
    },
  ],
  isServingReady: true,
  limit: 50,
  nextCursor: null,
  page: 1,
  servingStatus: 'ready',
  servingUpdatedAt: null,
  totalCount: null,
  totalPages: null,
}

const getJsonResponse = (data: unknown) => {
  return new Response(JSON.stringify({data}), {headers: {'Content-Type': 'application/json'}, status: 200})
}

const columns = [
  {
    contentKey: null,
    contentLabel: null,
    id: 'llm:model-1:prompt-1',
    kind: 'llm' as const,
    modelId: 'model-1',
    modelLabel: 'Model 1',
    promptId: 'prompt-1',
    promptLabel: 'Prompt 1',
    sourceProjectId: null,
    sourceProjectName: null,
  },
]

describe('conflict comments through the real API client', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  test('keeps date-looking comments, titles and names as text and renders them', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return getJsonResponse(page)
      }),
    )
    const fetchedPage = await fetchComparisonProjectJudgmentsPage('comparison-project-1', 50, [], [], [], [], '')
    const [row] = fetchedPage.data

    expect(row?.conflictComment?.comment).toBe('2026-10-10')
    expect(row?.conflictComment?.author?.displayName).toBe('10/10/2026')
    expect(row?.articleTitle).toBe('10/10/2026')
    expect(row?.conflictResolution?.reviewerDisplayName).toBe('10/10/2026')
    expect(row?.conflictResolution?.setAt).toEqual(new Date('2026-10-10T09:00:00.000Z'))
    expect(row?.conflictComment?.updatedAt).toEqual(new Date('2026-10-10T09:30:00.000Z'))

    const container = document.createElement('div')
    document.body.appendChild(container)
    const dispose = render(() => {
      return (
        <ComparisonProjectJudgmentsTable
          columns={columns}
          conflictResolutionEnabled={true}
          conflictResolutionOptions={[{label: 'yes', value: 'yes'}]}
          rows={fetchedPage.data}
        />
      )
    }, container)

    try {
      await Promise.resolve()
      const button = container.querySelector<HTMLButtonElement>('button[aria-label^="Edit comment"]')

      expect(container.textContent).toContain('10/10/2026')
      expect(button?.dataset.hasComment).toBe('true')
      expect(button?.title.split('\n')[0]).toBe('2026-10-10')
      expect(button?.title.split('\n')[1]).toMatch(/^Comment by 10\/10\/2026, 2026-10-1\d \d{2}:30$/)

      button?.click()
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0)
      })

      expect(document.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('2026-10-10')
    } finally {
      dispose()
    }
  })

  test('keeps an exact timestamp typed as a comment as text in the save response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return getJsonResponse({
          articleId: 'article-dated',
          conflictComment: {...conflictComment, comment: '2026-10-10T12:00:00.000Z'},
        })
      }),
    )

    const saved = await setComparisonProjectConflictComment('comparison-project-1', {
      articleId: 'article-dated',
      comment: '2026-10-10T12:00:00.000Z',
    })

    expect(saved.conflictComment?.comment).toBe('2026-10-10T12:00:00.000Z')
    expect(saved.conflictComment?.updatedAt).toEqual(new Date('2026-10-10T09:30:00.000Z'))
  })
})
