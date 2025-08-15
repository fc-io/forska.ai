// reviewArticleDetailsGetHighlightedText.test.ts
import {describe, expect, it} from 'vitest'

import {reviewArticleDetailsGetHighlightedText} from './reviewArticleDetailsGetHighlightedText'

type Piece = [string, boolean]

// NOTE: In the user's original test name, "preserver" ⇒ "preserve" and "off" ⇒ "of" – minor typos only.

describe('reviewArticleDetailsGetHighlightedText – fuzzy (Damerau–Levenshtein)', () => {
  it('no fuzzy when maxDistance=0 (default) – behaves as exact', () => {
    const s = 'quikc'
    const keys = ['quick']
    const expected: Piece[] = [['quikc', false]]
    expect(expected).toEqual(reviewArticleDetailsGetHighlightedText(s, keys))
  })

  it('transposition within distance 1 – highlights "quikc" for key "quick"', () => {
    const s = 'The quikc brown fox'
    const keys = ['quick']
    const expected: Piece[] = [
      ['The ', false],
      ['quikc', true], // transposition of c/k
      [' brown fox', false],
    ]
    expect(expected).toEqual(
      reviewArticleDetailsGetHighlightedText(s, keys, {maxDistance: 1}),
    )
  })

  it('single deletion within distance 1 – highlights "speling" for key "spelling"', () => {
    const s = 'Fix the speling please'
    const keys = ['spelling']
    const expected: Piece[] = [
      ['Fix the ', false],
      ['speling', true],
      [' please', false],
    ]
    expect(expected).toEqual(
      reviewArticleDetailsGetHighlightedText(s, keys, {maxDistance: 1}),
    )
  })

  it('prefers exact over fuzzy when both are present in the same token', () => {
    const s = 'xxquikcquickyy'
    const keys = ['quick']
    const expected: Piece[] = [
      ['xxquikc', false], // fuzzy candidate exists earlier, but exact later in same token is preferred
      ['quick', true],
      ['yy', false],
    ]
    expect(expected).toEqual(
      reviewArticleDetailsGetHighlightedText(s, keys, {maxDistance: 1}),
    )
  })

  it('one match per key across the whole string even with fuzzy enabled', () => {
    const s = ' speling spelling'
    const keys = ['spelling']
    const expected: Piece[] = [
      [' ', false], // first token has leading empty before the match
      ['speling', true],
      [' spelling', false],
    ]
    expect(expected).toEqual(
      reviewArticleDetailsGetHighlightedText(s, keys, {maxDistance: 1}),
    )
  })

  it('inside one token with multiple candidate keys – chooses smaller distance, then longer key', () => {
    const s = 'colour'
    const keys = ['color', 'colour']
    // "colour" is exact (dist 0) vs "color" is fuzzy (dist 1) – exact should win.
    const expected: Piece[] = [['colour', true]]
    expect(expected).toEqual(
      reviewArticleDetailsGetHighlightedText(s, keys, {maxDistance: 1}),
    )
  })

  it('case-insensitive fuzzy match when option set', () => {
    const s = 'FOO quikc'
    const keys = ['foo', 'quick']
    const expected: Piece[] = [
      ['FOO', true],
      [' ', false],
      ['quikc', true], // transposition; also case-insensitive for "foo"
    ]
    expect(expected).toEqual(
      reviewArticleDetailsGetHighlightedText(s, keys, {
        maxDistance: 1,
        caseInsensitive: true,
      }),
    )
  })
})
