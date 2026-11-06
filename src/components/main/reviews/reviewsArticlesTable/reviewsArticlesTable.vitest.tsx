// @vitest-environment happy-dom

import {createSignal} from 'solid-js'
import {render} from 'solid-js/web'
import {afterEach, describe, expect, test, vi} from 'vitest'

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
})
