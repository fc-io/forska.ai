import {readFileSync} from 'node:fs'

import {expect, test} from 'bun:test'

import {
  getAvailableReviewDetail,
  getReviewDetailUnavailableMessage,
  isUnavailableReviewDetail,
} from './reviewDetailReadiness'

const reviewDetailRouteFiles = [
  'src/app/routes/+projects/+$id/+reviews-llm/+$articleId/+index.tsx',
  'src/app/routes/+projects/+$id/+reviews-llm/+$articleId/+fulltext.tsx',
]

test('review detail readiness helpers distinguish unavailable V4 detail state from available payloads', () => {
  const unavailable = {article: null, reason: 'detail row unavailable', status: 'unavailable'}
  const available = {article: {articleTitle: 'Ready article'}, status: 'ready'}

  expect(isUnavailableReviewDetail(unavailable)).toBe(true)
  expect(isUnavailableReviewDetail(available)).toBe(false)
  expect(getAvailableReviewDetail(unavailable)).toBeNull()
  expect(getAvailableReviewDetail(available)).toBe(available)
  expect(getReviewDetailUnavailableMessage(unavailable)).toContain('detail row unavailable')
})

test('review detail browser routes do not render unavailable payloads as article details', () => {
  for (const routeFile of reviewDetailRouteFiles) {
    const source = readFileSync(routeFile, 'utf8')

    expect(source).toContain('ReviewDetailUnavailableState')
    expect(source).toContain('availableDetail()')
    expect(source).not.toContain('<Show when={articleQuery.data}>')
    expect(source).not.toContain('document.title = getArticleDocumentTitle(articleQuery.data?.article')
  }
})
