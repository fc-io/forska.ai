import {readFileSync} from 'node:fs'
import {join} from 'node:path'

import {expect, test} from 'bun:test'

import {reviewServingSearchOwnership} from './reviewServingSearchOwnership.ts'

const repoRoot = join(import.meta.dir, '../../..')

test('search ownership keeps production list routes on token-prefix serving readers', () => {
  expect(reviewServingSearchOwnership).toMatchObject({
    asyncSubstringOwner: 'reviewSearchService',
    productionListOwner: 'routeServiceTokenPrefixReader',
    readySearchMode: 'tokenPrefix',
    substringSearchMode: 'substringAsync',
  })

  const routeServiceSources = reviewServingSearchOwnership.productionRouteServiceFiles.map((filePath) => {
    return readFileSync(join(repoRoot, filePath), 'utf8')
  })

  routeServiceSources.map((source) => {
    expect(source).toContain('getReviewServingTitleSearchTokens')
    expect(source).toContain('readReviewServingRows')
    expect(source).not.toContain('searchReviewServing')
    return source
  })
})

test('reviewSearchService remains the internal owner for substring async work', () => {
  const source = readFileSync(join(repoRoot, 'src/server/reviewServing/reviewSearchService.ts'), 'utf8')

  expect(source).toContain('export const searchReviewServing')
  expect(source).toContain('review.search.substringAsync')
  expect(source).toContain('INSERT INTO app.review_search_job')
  expect(source).toContain("searchMode: 'substringAsync'")
})
