// @vitest-environment happy-dom

import {render} from 'solid-js/web'
import {afterEach, beforeEach, expect, test, vi} from 'vitest'

import {ReviewArticleDetails} from './reviewArticleDetails.tsx'
import {
  reviewArticleDetailsGetHighlightedTextHtml,
  type ReviewArticleDetailsHighlightTextKind,
} from './reviewArticleDetails/reviewArticleDetailsHighlightTextHtml.ts'
import {reviewArticleDetailsDispatchScrollToQuote} from './reviewArticleDetails/reviewArticleDetailsScrollEvents.ts'

type ReviewArticleDetailsTestProps = Parameters<typeof ReviewArticleDetails>[0]

type FakeWorkerRequest = {
  cacheKey?: string
  kind?: ReviewArticleDetailsHighlightTextKind
  quotes?: string[]
  requestId?: number
  text?: string
  type: string
}

const article = {
  articleAuthors: ['Alice Example', 'Bob Example'],
  articleId: 'external-1',
  articleSummary: 'Abstract text',
  articleTitle: 'Article 1',
  fullText: 'Full text body',
  id: 'article-1',
}

const articleMetadata = [
  {label: 'journal', value: 'BMJ'},
  {label: 'year', value: '2019'},
  {label: 'publication_type', value: 'published'},
  {label: 'doi', value: '10.1000/example'},
]

const projectHeading = 'Article metadata (sent to the model)'

const workerRequests: FakeWorkerRequest[] = []

class FakeHighlightWorker {
  onmessage: ((event: {data: unknown}) => void) | null = null

  postMessage(request: FakeWorkerRequest) {
    workerRequests.push(request)

    if (request.type === 'highlightText') {
      const html = reviewArticleDetailsGetHighlightedTextHtml({
        kind: request.kind ?? 'title',
        quotes: request.quotes ?? [],
        text: request.text ?? '',
      })

      queueMicrotask(() => {
        this.onmessage?.({data: {...request, html, type: 'highlightTextResult'}})
      })
    }
  }

  terminate() {
    return undefined
  }
}

beforeEach(() => {
  workerRequests.length = 0
  vi.stubGlobal('Worker', FakeHighlightWorker)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

const renderReviewArticleDetails = (props: Omit<ReviewArticleDetailsTestProps, 'article'>) => {
  const container = document.createElement('div')
  document.body.appendChild(container)

  const dispose = render(() => {
    return <ReviewArticleDetails article={article} enableSticky={false} showTitle={false} {...props} />
  }, container)

  return {container, dispose}
}

const getMetadataBlock = (container: ParentNode) => {
  return container.querySelector('[data-testid="review-article-metadata"]')
}

const getMetadataMarks = (container: ParentNode) => {
  return Array.from(getMetadataBlock(container)?.querySelectorAll('[data-review-highlight="true"]') ?? []).map(
    (element) => {
      return element.textContent
    },
  )
}

const getJudgment = (quotes: string[]) => {
  return {id: 'judgment-1', prompt: {originalText: 'Is it a trial?'}, quotes}
}

test('ReviewArticleDetails shows the metadata lines in prompt form under the authors in summary mode', () => {
  const {container, dispose} = renderReviewArticleDetails({
    articleMetadata,
    articleMetadataHeading: projectHeading,
    viewMode: 'summary',
  })
  const block = getMetadataBlock(container)
  const text = container.textContent ?? ''

  expect(block?.querySelector('p')?.textContent).toBe(projectHeading)
  expect(block?.querySelector('div')?.textContent).toBe(
    'journal: BMJ\nyear: 2019\npublication_type: published\ndoi: 10.1000/example',
  )
  expect(text.indexOf(projectHeading)).toBeGreaterThan(text.indexOf('Authors: Alice Example, Bob Example'))
  expect(text.indexOf(projectHeading)).toBeLessThan(text.indexOf('Abstract text'))

  dispose()
})

test('ReviewArticleDetails uses the plain Article metadata heading by default and shows none available for []', () => {
  const {container, dispose} = renderReviewArticleDetails({articleMetadata: [], viewMode: 'all'})
  const block = getMetadataBlock(container)

  expect(block?.textContent).toBe('Article metadatanone available')
  expect(block?.querySelectorAll('[data-review-highlight="true"]')).toHaveLength(0)

  dispose()
})

test('ReviewArticleDetails renders metadata values as text, not HTML', () => {
  const {container, dispose} = renderReviewArticleDetails({
    articleMetadata: [{label: 'journal', value: 'Science & <b>Medicine</b>'}],
    viewMode: 'summary',
  })
  const lines = getMetadataBlock(container)?.querySelector('div')

  expect(lines?.textContent).toBe('journal: Science & <b>Medicine</b>')
  expect(lines?.querySelector('b')).toBeNull()

  dispose()
})

test('ReviewArticleDetails renders no metadata block without the prop, with null, or in fulltext mode', () => {
  const renders = [
    renderReviewArticleDetails({viewMode: 'summary'}),
    renderReviewArticleDetails({articleMetadata: null, viewMode: 'summary'}),
    renderReviewArticleDetails({articleMetadata, articleMetadataHeading: projectHeading, viewMode: 'fulltext'}),
  ]

  expect(document.body.textContent).toContain('Authors: Alice Example, Bob Example')
  expect(document.body.textContent).not.toContain('Article metadata')
  expect(getMetadataBlock(document)).toBeNull()

  renders.map(({dispose}) => {
    return dispose()
  })
})

test('ReviewArticleDetails highlights a quoted metadata value and a quoted whole line with the review mark', async () => {
  const {container, dispose} = renderReviewArticleDetails({
    articleMetadata,
    judgment: getJudgment(['BMJ', 'publication_type: published']),
    viewMode: 'summary',
  })

  await vi.waitFor(() => {
    expect(getMetadataMarks(container)).toEqual(['BMJ', 'publication_type: published'])
  })
  expect(getMetadataBlock(container)?.querySelector('div')?.textContent).toBe(
    'journal: BMJ\nyear: 2019\npublication_type: published\ndoi: 10.1000/example',
  )
  expect(
    workerRequests.filter((request) => {
      return request.kind === 'metadata'
    }),
  ).toMatchObject([{quotes: ['BMJ', 'publication_type: published'], type: 'highlightText'}])

  dispose()
})

test('ReviewArticleDetails does not highlight metadata for a quote that is not in it', async () => {
  const {container, dispose} = renderReviewArticleDetails({
    articleMetadata,
    judgment: getJudgment(['Lancet', 'Abstract text']),
    viewMode: 'summary',
  })

  await vi.waitFor(() => {
    expect(container.querySelectorAll('[data-review-highlight="true"]')).toHaveLength(1)
  })
  expect(getMetadataMarks(container)).toEqual([])
  expect(container.querySelector('[data-review-highlight="true"]')?.textContent).toBe('Abstract text')

  dispose()
})

test('ReviewArticleDetails scrolls to a quote mark inside the metadata block', async () => {
  const scrolledElements: Element[] = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    return window.setTimeout(() => {
      callback(0)
    }, 0)
  })
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
    window.clearTimeout(handle)
  })
  vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) {
    scrolledElements.push(this)
  })
  const {container, dispose} = renderReviewArticleDetails({
    articleMetadata,
    judgment: getJudgment(['10.1000/example']),
    viewMode: 'summary',
  })

  await vi.waitFor(() => {
    expect(getMetadataMarks(container)).toEqual(['10.1000/example'])
  })
  reviewArticleDetailsDispatchScrollToQuote({judgmentId: 'judgment-1', quote: '10.1000/example', quoteIndex: 0})

  await vi.waitFor(() => {
    expect(scrolledElements).toHaveLength(1)
  })
  expect(scrolledElements[0]?.textContent).toBe('10.1000/example')
  expect(getMetadataBlock(container)?.contains(scrolledElements[0] ?? null)).toBe(true)

  dispose()
})
