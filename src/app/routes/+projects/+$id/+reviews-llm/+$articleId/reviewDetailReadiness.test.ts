import {readFileSync} from 'node:fs'

import {expect, test} from 'bun:test'

import {
  getArchivedReviewDetailFromResponseError,
  getAvailableReviewDetail,
  getReviewDetailUnavailableMessage,
  isArchivedReviewDetail,
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

test('review detail readiness helpers distinguish archived projects from unavailable V4 detail state', () => {
  const archived = {
    article: null,
    code: 'PROJECT_ARCHIVED',
    message: 'Unarchive this project before reviewing articles.',
    status: 'archived',
  }
  const responseError = {value: archived}

  expect(isArchivedReviewDetail(archived)).toBe(true)
  expect(isUnavailableReviewDetail(archived)).toBe(false)
  expect(getAvailableReviewDetail(archived)).toBeNull()
  expect(getArchivedReviewDetailFromResponseError(responseError)).toBe(archived)
})

test('review detail browser routes do not render unavailable payloads as article details', () => {
  for (const routeFile of reviewDetailRouteFiles) {
    const source = readFileSync(routeFile, 'utf8')

    expect(source).toContain('ReviewDetailUnavailableState')
    expect(source).toContain('ReviewDetailArchivedState')
    expect(source).toContain('getArchivedReviewDetailFromResponseError(response.error)')
    expect(source).toContain('isArchivedReviewDetail(articleQuery.data)')
    expect(source).toContain('availableDetail()')
    expect(source).not.toContain('<Show when={articleQuery.data}>')
    expect(source).not.toContain('document.title = getArticleDocumentTitle(articleQuery.data?.article')
  }
})
