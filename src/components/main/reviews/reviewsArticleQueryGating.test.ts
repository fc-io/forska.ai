import {readFileSync} from 'node:fs'
import {join} from 'node:path'

import {expect, test} from 'bun:test'

const projectRoot = process.cwd()

const reviewArticleContainerFiles = [
  'src/components/main/reviews/reviewsArticlesTable/reviewsArticlesTableContainer.tsx',
  'src/components/main/reviews/reviewsArticlesTable/reviewsArticlesBothTableContainer.tsx',
  'src/components/main/reviews/reviewsArticlesTable/reviewsArticlesHumanTableContainer.tsx',
  'src/components/main/reviews/reviewsArticlesTable/reviewsArticlesUnassessedTableContainer.tsx',
] as const

const llmReviewFirstLoadFiles = [
  'src/app/routes/+projects/+$id/+reviews-llm/+index.tsx',
  'src/components/main/reviews/reviewsArticlesTable/reviewsArticlesTableContainer.tsx',
] as const

const readSource = (path: string) => {
  return readFileSync(join(projectRoot, path), 'utf8')
}

test('review article queries do not treat warning-query failure as serving readiness', () => {
  const violatingFiles = reviewArticleContainerFiles.filter((path) => {
    const source = readSource(path)

    return source.includes('warningsQuery.isError') || source.includes('|| warningsQuery.error')
  })

  expect(violatingFiles).toEqual([])
})

test('review article query gates stay tied to V4 serving readability', () => {
  const missingReadableGate = reviewArticleContainerFiles.filter((path) => {
    const source = readSource(path)

    return (
      !source.includes('return warningsQuery.data?.indexing.serving.readable === true')
      || !source.includes('return isReviewServingReadable()')
    )
  })

  expect(missingReadableGate).toEqual([])
})

test('review article tables render current query rows before pagination cache effect settles', () => {
  const missingCurrentQueryFallback = reviewArticleContainerFiles.filter((path) => {
    const source = readSource(path)

    return (
      !source.includes('const currentPageData = Array.isArray(articlesQuery.data?.data)')
      || !source.includes('page === currentPage ? currentPageData : []')
    )
  })

  expect(missingCurrentQueryFallback).toEqual([])
})

test('LLM review prompt answer facets are lazy until prompt filter workflow is opened', () => {
  const source = readSource('src/components/main/reviews/reviewsFilterControls.tsx')

  expect(source).toContain('const [promptFiltersRequested, setPromptFiltersRequested] = createSignal(false)')
  expect(source).toContain('enabled: !props.hidePromptSelectors && promptFiltersRequested()')
  expect(source).toContain('setPromptFiltersRequested(true)')
  expect(source).toContain('Show prompt answer filters')
  expect(source).toContain('apiClient.api.articlesreviewsfilters.get')
})

test('Human/Both review prompt answer facets are lazy until prompt filter workflow is opened', () => {
  const source = readSource('src/components/main/reviews/reviewsHumanFilterControls.tsx')

  expect(source).toContain('const [promptFiltersRequested, setPromptFiltersRequested] = createSignal(false)')
  expect(source).toContain('enabled: !props.hidePromptSelectors && promptFiltersRequested()')
  expect(source).toContain('setPromptFiltersRequested(true)')
  expect(source).toContain('Show prompt answer filters')
  expect(source).toContain('apiClient.api.articlesreviewshumanfilters.get')
})

test('prompt facet normalization preserves prompt filter state identity when values did not change', () => {
  const filterControlFiles = [
    'src/components/main/reviews/reviewsFilterControls.tsx',
    'src/components/main/reviews/reviewsHumanFilterControls.tsx',
  ] as const
  const missingNoopGuard = filterControlFiles.filter((path) => {
    const source = readSource(path)

    return !source.includes('let changed = false') || !source.includes('return changed ? next : prev')
  })

  expect(missingNoopGuard).toEqual([])
})

test('LLM review list first load does not hydrate article detail payloads', () => {
  const violatingFiles = llmReviewFirstLoadFiles.filter((path) => {
    const source = readSource(path)

    return source.includes('apiClient.api.projectsreview.post') || source.includes("['article-review-details'")
  })

  expect(violatingFiles).toEqual([])
})

test('review bulk action target projects query is lazy until action menu is opened', () => {
  const source = readSource('src/components/main/reviews/reviewsPaginationControls.tsx')

  expect(source).toContain('const [addToProjectMenuOpened, setAddToProjectMenuOpened] = createSignal(false)')
  expect(source).toContain('enabled: addToProjectMenuOpened()')
  expect(source).toContain('setAddToProjectMenuOpened(true)')
  expect(source).toContain("apiClient.api['projects-without-jobs'].get()")
})
