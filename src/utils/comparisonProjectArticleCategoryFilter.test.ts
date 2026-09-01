import {describe, expect, test} from 'vitest'

import {getHasComparisonProjectChineseArticles} from './comparisonProjectArticleCategoryFilter.ts'

describe('getHasComparisonProjectChineseArticles', () => {
  test('requires at least one Chinese article', () => {
    expect(
      getHasComparisonProjectChineseArticles([
        {articleCount: 0, category: 'chinese'},
        {articleCount: 4, category: 'non_chinese'},
      ]),
    ).toBe(false)
    expect(
      getHasComparisonProjectChineseArticles([
        {articleCount: 2, category: 'chinese'},
        {articleCount: 4, category: 'non_chinese'},
      ]),
    ).toBe(true)
  })

  test('treats missing category stats as unavailable', () => {
    expect(getHasComparisonProjectChineseArticles(undefined)).toBe(false)
    expect(getHasComparisonProjectChineseArticles([{articleCount: 4, category: 'non_chinese'}])).toBe(false)
  })
})
