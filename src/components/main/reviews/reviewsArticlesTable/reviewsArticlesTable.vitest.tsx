// @vitest-environment happy-dom

import {createSignal} from 'solid-js'
import {render} from 'solid-js/web'
import {afterEach, describe, expect, test, vi} from 'vitest'

import {type ArticleWithHumanJudgments, ReviewsArticlesHumanTable} from './reviewsArticlesHumanTable'
import {type ArticleWithJudgments, ReviewsArticlesTable} from './reviewsArticlesTable'

vi.mock('@tanstack/solid-router', () => {
  return {
    Link: (props: {children: unknown; class?: string; params?: {articleId?: string; id?: string}; to: string}) => {
      return (
        <a
          class={props.class}
          href={props.to.replace('$id', props.params?.id ?? '').replace('$articleId', props.params?.articleId ?? '')}
        >
          {props.children}
        </a>
      )
    },
  }
})

const getArticle = (overrides: Partial<ArticleWithJudgments> = {}): ArticleWithJudgments => {
  return {
    id: 'article-1',
    articleTitle: 'Indexing article',
    articleCreatedAt: null,
    articleUpdatedAt: null,
    judgments: [],
    ...overrides,
  }
}

const renderTable = (articles: ArticleWithJudgments[]) => {
  const [rowSelection, setRowSelection] = createSignal<Record<string, boolean>>({})
  const container = document.createElement('div')
  document.body.appendChild(container)
  const dispose = render(() => {
    return (
      <ReviewsArticlesTable
        articles={articles}
        projectId="project-1"
        rowSelection={rowSelection}
        setRowSelection={setRowSelection}
      />
    )
  }, container)

  return {container, dispose}
}

describe('ReviewsArticlesTable', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  test('renders article rows while marking payload-backed judgment details as indexing', () => {
    const {container, dispose} = renderTable([getArticle({detailReadiness: 'indexing', judgments: []})])

    try {
      expect(container.textContent).toContain('Indexing article')
      expect(container.textContent).toContain('Details indexing')
      expect(container.textContent).not.toContain('Loading articles')
      expect(container.textContent).not.toContain('No articles to display')
    } finally {
      dispose()
      container.remove()
    }
  })

  test('keeps judgment chips visible when detail readiness is ready or omitted', () => {
    const {container, dispose} = renderTable([
      getArticle({judgments: [{id: 'judgment-1', promptId: 'prompt-1', answeredOriginal: 'yes'}]}),
    ])

    try {
      expect(container.textContent).toContain('Indexing article')
      expect(container.textContent).toContain('AI')
      expect(container.textContent).toContain('Y')
      expect(container.textContent).not.toContain('Details indexing')
    } finally {
      dispose()
      container.remove()
    }
  })

  test('decodes sanitized article title markup in review list links', () => {
    const {container, dispose} = renderTable([
      getArticle({
        articleTitle:
          'Draft genome sequence of &lt;i&gt;Stutzerimonas degradans&lt;/i&gt; strain RB, a bacterium capable of complete denitrification.',
      }),
    ])

    try {
      const link = container.querySelector('a')

      expect(link?.textContent).toContain('Draft genome sequence of Stutzerimonas degradans strain RB')
      expect(link?.textContent).not.toContain('<i>')
      expect(link?.querySelector('i')?.textContent).toBe('Stutzerimonas degradans')
    } finally {
      dispose()
      container.remove()
    }
  })

  test('labels rows without any LLM judgment as not judged instead of partial', () => {
    const {container, dispose} = renderTable([
      getArticle({id: 'unjudged', hasLlmJudgment: false, isFullyJudged: false, judgedPromptIds: []}),
      getArticle({id: 'partial-unloaded', hasLlmJudgment: true, isFullyJudged: false, judgedPromptIds: []}),
      getArticle({
        id: 'partial-loaded',
        isFullyJudged: false,
        judgedPromptIds: ['prompt-1'],
        judgments: [{id: 'judgment-1', promptId: 'prompt-1', answeredOriginal: 'yes'}],
      }),
      getArticle({id: 'legacy-unjudged', isFullyJudged: false, judgedPromptIds: []}),
    ])

    try {
      const statuses = [...container.querySelectorAll('tbody tr')].map((row) => {
        return row.querySelector('td:nth-child(2) span')?.textContent
      })

      expect(statuses).toEqual(['Not judged', 'Partial', 'Partial', 'Not judged'])
    } finally {
      dispose()
      container.remove()
    }
  })

  test('marks provider-refused rows with a refused count instead of not judged', () => {
    const {container, dispose} = renderTable([
      getArticle({
        id: 'fully-refused',
        hasLlmJudgment: false,
        isFullyJudged: false,
        judgedPromptIds: [],
        llmRefusedPromptCount: 3,
      }),
      getArticle({
        id: 'partly-refused',
        hasLlmJudgment: true,
        isFullyJudged: false,
        judgedPromptIds: ['prompt-1'],
        llmRefusedPromptCount: 1,
      }),
      getArticle({
        id: 'unjudged',
        hasLlmJudgment: false,
        isFullyJudged: false,
        judgedPromptIds: [],
        llmRefusedPromptCount: 0,
      }),
      getArticle({id: 'complete', hasLlmJudgment: true, isFullyJudged: true, llmRefusedPromptCount: 0}),
    ])

    try {
      const statusBadges = [...container.querySelectorAll('tbody tr')].map((row) => {
        return [...row.querySelectorAll('td:nth-child(2) span')].map((badge) => {
          return [badge.textContent, badge.getAttribute('title')]
        })
      })

      expect(statusBadges).toEqual([
        [['3 refused', 'The model refused 3 prompt(s); needs human screening']],
        [
          ['Partial', '1 prompt(s) judged, 0 judgment(s)'],
          ['1 refused', 'The model refused 1 prompt(s); needs human screening'],
        ],
        [['Not judged', 'No prompts judged yet']],
        [['Complete', 'All prompts judged']],
      ])
    } finally {
      dispose()
      container.remove()
    }
  })

  test('shows the refused count on rows without an LLM status, as on the both-reviews tab', () => {
    const {container, dispose} = renderTable([
      getArticle({id: 'both-refused', llmRefusedPromptCount: 2}),
      getArticle({id: 'both-clean', llmRefusedPromptCount: 0}),
    ])

    try {
      const statuses = [...container.querySelectorAll('tbody tr')].map((row) => {
        return row.querySelector('td:nth-child(2) span')?.textContent
      })

      expect(statuses).toEqual(['2 refused', '—'])
    } finally {
      dispose()
      container.remove()
    }
  })
  test('marks rows with failed closeouts with a failed count next to the status and the refused count', () => {
    const {container, dispose} = renderTable([
      getArticle({
        id: 'partly-failed',
        hasLlmJudgment: true,
        isFullyJudged: false,
        judgedPromptIds: ['prompt-1'],
        llmFailedPromptCodes: 'claude_code_request_failed',
        llmFailedPromptCount: 1,
        llmRefusedPromptCount: 0,
      }),
      getArticle({
        id: 'failed-and-refused',
        hasLlmJudgment: false,
        isFullyJudged: false,
        judgedPromptIds: [],
        llmFailedPromptCodes: 'claude_code_request_failed',
        llmFailedPromptCount: 2,
        llmRefusedPromptCount: 1,
      }),
      getArticle({id: 'both-tab-failed', llmFailedPromptCodes: 'claude_code_request_failed', llmFailedPromptCount: 1}),
    ])

    try {
      const statusBadges = [...container.querySelectorAll('tbody tr')].map((row) => {
        return [...row.querySelectorAll('td:nth-child(2) span')].map((badge) => {
          return [badge.textContent, badge.getAttribute('title')]
        })
      })

      expect(statusBadges).toEqual([
        [
          ['Partial', '1 prompt(s) judged, 0 judgment(s)'],
          ['1 failed', 'The model call failed after retries (claude_code_request_failed); resume the job to retry'],
        ],
        [
          ['1 refused', 'The model refused 1 prompt(s); needs human screening'],
          ['2 failed', 'The model call failed after retries (claude_code_request_failed); resume the job to retry'],
        ],
        [['1 failed', 'The model call failed after retries (claude_code_request_failed); resume the job to retry']],
      ])
    } finally {
      dispose()
      container.remove()
    }
  })
})

// The human table renders a few display fields; the full article record shape is irrelevant to these tests.
const getHumanArticle = (overrides: {
  id: string
  llmFailedPromptCodes?: string | null
  llmFailedPromptCount?: number
  llmRefusedPromptCount: number
}) => {
  return {
    ...getArticle({id: overrides.id}),
    llmFailedPromptCodes: overrides.llmFailedPromptCodes ?? null,
    llmFailedPromptCount: overrides.llmFailedPromptCount ?? 0,
    llmRefusedPromptCount: overrides.llmRefusedPromptCount,
  } as unknown as ArticleWithHumanJudgments
}

const renderHumanTable = (articles: ArticleWithHumanJudgments[]) => {
  const [rowSelection, setRowSelection] = createSignal<Record<string, boolean>>({})
  const container = document.createElement('div')
  document.body.appendChild(container)
  const dispose = render(() => {
    return (
      <ReviewsArticlesHumanTable
        articles={articles}
        projectId="project-1"
        rowSelection={rowSelection}
        setRowSelection={setRowSelection}
      />
    )
  }, container)

  return {container, dispose}
}

describe('ReviewsArticlesHumanTable', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  test('shows the refused count in the status column', () => {
    const {container, dispose} = renderHumanTable([
      getHumanArticle({id: 'human-refused', llmRefusedPromptCount: 4}),
      getHumanArticle({id: 'human-clean', llmRefusedPromptCount: 0}),
    ])

    try {
      const headers = [...container.querySelectorAll('thead th')].map((header) => {
        return header.textContent
      })
      const statuses = [...container.querySelectorAll('tbody tr')].map((row) => {
        const badge = row.querySelector('td:nth-child(2) span')
        return [badge?.textContent, badge?.getAttribute('title') ?? null]
      })

      expect(headers[1]).toBe('Status')
      expect(statuses).toEqual([
        ['4 refused', 'The model refused 4 prompt(s); needs human screening'],
        ['—', null],
      ])
    } finally {
      dispose()
      container.remove()
    }
  })

  test('shows the failed count in the status column next to the refused count', () => {
    const {container, dispose} = renderHumanTable([
      getHumanArticle({
        id: 'human-failed',
        llmFailedPromptCodes: 'claude_code_request_failed',
        llmFailedPromptCount: 2,
        llmRefusedPromptCount: 1,
      }),
      getHumanArticle({id: 'human-clean', llmRefusedPromptCount: 0}),
    ])

    try {
      const statuses = [...container.querySelectorAll('tbody tr')].map((row) => {
        return [...row.querySelectorAll('td:nth-child(2) span')].map((badge) => {
          return [badge.textContent, badge.getAttribute('title')]
        })
      })

      expect(statuses).toEqual([
        [
          ['1 refused', 'The model refused 1 prompt(s); needs human screening'],
          ['2 failed', 'The model call failed after retries (claude_code_request_failed); resume the job to retry'],
        ],
        [['—', null]],
      ])
    } finally {
      dispose()
      container.remove()
    }
  })
})
