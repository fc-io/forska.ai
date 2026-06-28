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
