import {expect, test} from 'bun:test'

import {reviewArticleDetailsGetHighlightedTextHtml} from './reviewArticleDetailsHighlightTextHtml.ts'
import {reviewArticleDetailsNormalizeQuoteForHtmlMatch} from './reviewArticleDetailsNormalizeQuoteForHtmlMatch.ts'

const metadataText = 'journal: BMJ\nyear: 2019\ndoi: 10.1000/example'

const mark = (text: string) => {
  return `<span class="text-red-500 underline" data-review-highlight="true">${text}</span>`
}

test('metadata highlighting marks a quoted value and a quoted whole line in the prompt line text', () => {
  expect(reviewArticleDetailsGetHighlightedTextHtml({kind: 'metadata', quotes: ['BMJ'], text: metadataText})).toBe(
    `journal: ${mark('BMJ')}\nyear: 2019\ndoi: 10.1000/example`,
  )
  expect(
    reviewArticleDetailsGetHighlightedTextHtml({kind: 'metadata', quotes: ['year: 2019'], text: metadataText}),
  ).toBe(`journal: BMJ\n${mark('year: 2019')}\ndoi: 10.1000/example`)
})

test('metadata highlighting is exact, so a near miss in a short value is not marked like it is in the summary', () => {
  expect(reviewArticleDetailsGetHighlightedTextHtml({kind: 'metadata', quotes: ['2018'], text: metadataText})).toBe(
    metadataText,
  )
  expect(reviewArticleDetailsGetHighlightedTextHtml({kind: 'summary', quotes: ['2018'], text: metadataText})).toContain(
    mark('2019'),
  )
  expect(
    reviewArticleDetailsGetHighlightedTextHtml({
      kind: 'metadata',
      quotes: ['Lancet', 'fell from 62 to 41'],
      text: metadataText,
    }),
  ).toBe(metadataText)
})

test('metadata highlighting matches normalized quotes against HTML-escaped values', () => {
  expect(
    reviewArticleDetailsGetHighlightedTextHtml({
      kind: 'metadata',
      quotes: [reviewArticleDetailsNormalizeQuoteForHtmlMatch('Science & Medicine')],
      text: 'journal: Science &amp; Medicine',
    }),
  ).toBe(`journal: ${mark('Science &amp; Medicine')}`)
})
