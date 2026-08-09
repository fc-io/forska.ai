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
})
