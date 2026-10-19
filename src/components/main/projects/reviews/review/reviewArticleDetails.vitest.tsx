// @vitest-environment happy-dom

import {render} from 'solid-js/web'
import {afterEach, expect, test} from 'vitest'

import {ReviewArticleDetails} from './reviewArticleDetails.tsx'

type ReviewArticleDetailsTestProps = Parameters<typeof ReviewArticleDetails>[0]

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

const metadataHeading = 'Article metadata (sent to the model)'

afterEach(() => {
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

const getMetadataBlock = (container: HTMLElement) => {
  return container.querySelector('[data-testid="review-article-metadata"]')
}

test('ReviewArticleDetails shows the article metadata lines under the authors in summary mode', () => {
  const {container, dispose} = renderReviewArticleDetails({articleMetadata, viewMode: 'summary'})
  const block = getMetadataBlock(container)
  const rows = Array.from(block?.querySelectorAll('dt') ?? []).map((term) => {
    return `${term.textContent}: ${term.nextElementSibling?.textContent}`
  })
  const text = container.textContent ?? ''

  expect(block?.textContent).toContain(metadataHeading)
  expect(rows).toEqual(['journal: BMJ', 'year: 2019', 'publication_type: published', 'doi: 10.1000/example'])
  expect(text.indexOf(metadataHeading)).toBeGreaterThan(text.indexOf('Authors: Alice Example, Bob Example'))
  expect(text.indexOf(metadataHeading)).toBeLessThan(text.indexOf('Abstract text'))

  dispose()
})

test('ReviewArticleDetails shows none available like the prompt when the metadata list is empty', () => {
  const {container, dispose} = renderReviewArticleDetails({articleMetadata: [], viewMode: 'summary'})
  const block = getMetadataBlock(container)

  expect(block?.textContent).toBe(`${metadataHeading}none available`)
  expect(block?.querySelectorAll('dt')).toHaveLength(0)

  dispose()
})

test('ReviewArticleDetails shows the article metadata in all mode', () => {
  const {container, dispose} = renderReviewArticleDetails({articleMetadata, viewMode: 'all'})

  expect(getMetadataBlock(container)?.textContent).toContain('journalBMJ')

  dispose()
})

test('ReviewArticleDetails renders no metadata block without the prop, with null, or in fulltext mode', () => {
  const renders = [
    renderReviewArticleDetails({viewMode: 'summary'}),
    renderReviewArticleDetails({articleMetadata: null, viewMode: 'summary'}),
    renderReviewArticleDetails({articleMetadata, viewMode: 'fulltext'}),
  ]

  expect(document.body.textContent).toContain('Authors: Alice Example, Bob Example')
  expect(document.body.textContent).not.toContain(metadataHeading)
  expect(document.querySelector('[data-testid="review-article-metadata"]')).toBeNull()

  renders.map(({dispose}) => {
    return dispose()
  })
})
