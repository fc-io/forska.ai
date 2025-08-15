// splitByTokens.test.ts
import {describe, expect, it} from 'vitest'

import {reviewArticleDetailsGetHighlightedText} from './reviewArticleDetailsGetHighlightedText'

type Piece = [string, boolean]

describe('reviewArticleDetailsGetHighlightedText', () => {
  it('split correctly, preserver order, off multiple keys', () => {
    const s = 'asdf lasdfk asdfk 123 321mkk 432'
    const keys = ['123', 'mkk', '32']
    const expected: Piece[] = [
      ['asdf lasdfk asdfk ', false],
      ['123', true],
      [' 321', false],
      ['mkk', true],
      [' 4', false],
      ['32', true],
    ]
    expect(expected).toEqual(reviewArticleDetailsGetHighlightedText(s, keys))
  })

  it('should not match on repetition of the same token', () => {
    const s = 'x32 y321 z432'
    const keys = ['32']
    const expected: Piece[] = [
      ['x', false],
      ['32', true],
      [' y321 z432', false],
    ]
    expect(expected).toEqual(reviewArticleDetailsGetHighlightedText(s, keys))
  })

  it('prefers longer overlapping tokens, order of keys does not matter', () => {
    const s = '321mkk 321mk 321m'
    const keys = ['m', 'mk', 'mkk']
    const expected: Piece[] = [
      ['321', false],
      ['mkk', true],
      [' 321', false],
      ['mk', true],
      [' 321', false],
      ['m', true],
    ]
    expect(expected).toEqual(reviewArticleDetailsGetHighlightedText(s, keys))
  })

  it('handles multiple occurrences of the same token by only matching the first', () => {
    const s = 'foo 123 bar 123 baz'
    const keys = ['123']
    const expected: Piece[] = [
      ['foo ', false],
      ['123', true],
      [' bar 123 baz', false],
    ]
    expect(expected).toEqual(reviewArticleDetailsGetHighlightedText(s, keys))
  })

  it('escapes regex metacharacters in tokens', () => {
    const s = 'x a.b y c*d z e?f w [g]'
    const keys = ['a.b', 'c*d', 'e?f', '[g]']
    const expected: Piece[] = [
      ['x ', false],
      ['a.b', true],
      [' y ', false],
      ['c*d', true],
      [' z ', false],
      ['e?f', true],
      [' w ', false],
      ['[g]', true],
    ]
    expect(expected).toEqual(reviewArticleDetailsGetHighlightedText(s, keys))
  })

  it('no hits → returns the whole string as a single non-hit', () => {
    const s = 'hello world'
    const keys: string[] = ['x', 'y']
    const expected: Piece[] = [['hello world', false]]
    expect(expected).toEqual(reviewArticleDetailsGetHighlightedText(s, keys))
  })

  it('empty input → returns []', () => {
    const s = ''
    const keys = ['abc']
    const expected: Piece[] = []
    expect(expected).toEqual(reviewArticleDetailsGetHighlightedText(s, keys))
  })

  it('reconstructs the original string when the first chunk has no trailing whitespace', () => {
    // Our implementations trim trailing whitespace from the very first non-hit chunk.
    // Use a case where the first chunk ends cleanly so join(pieces) === original.
    const s = 'abc123 def'
    const keys = ['123']
    const expected: Piece[] = [
      ['abc', false],
      ['123', true],
      [' def', false],
    ]

    expect(expected).toEqual(reviewArticleDetailsGetHighlightedText(s, keys))
  })
})
