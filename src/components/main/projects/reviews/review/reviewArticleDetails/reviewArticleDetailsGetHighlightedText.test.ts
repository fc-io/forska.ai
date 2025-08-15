// splitByTokens.test.ts
import {describe, expect, it} from 'vitest'

import {reviewArticleDetailsGetHighlightedText} from './reviewArticleDetailsGetHighlightedText'

type Piece = [string, boolean]

describe('splitByTokens (functional versions)', () => {
  it('matches your example exactly (trim trailing space before first hit)', () => {
    const s = 'asdf lasdfk asdfk 123 321mkk 432'
    const keys = ['123', 'mkk', '32']
    const expected: Piece[] = [
      ['asdf lasdfk asdfk', false],
      ['123', true],
      [' 321', false],
      ['mkk', true],
      [' 4', false],
      ['32', true],
    ]
    expect(expected).toEqual(reviewArticleDetailsGetHighlightedText(s, keys))
  })

  it('preserves order and allows non-boundary at start but requires boundary after token', () => {
    // '32' after 'x' is fine (start not required to be boundary) – ends with space → hit
    // '32' inside '321' is NOT a hit (next char is '1')
    // trailing '32' at end of string is a hit
    const s = 'x32 y321 z432'
    const keys = ['32']
    const expected: Piece[] = [
      ['x', false],
      ['32', true],
      [' y321 z4', false],
      ['32', true],
    ]
    expect(expected).toEqual(reviewArticleDetailsGetHighlightedText(s, keys))
  })

  it('prefers longer overlapping tokens (longest-first)', () => {
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

  it('handles multiple occurrences of the same token', () => {
    const s = 'foo 123 bar 123 baz'
    const keys = ['123']
    const expected: Piece[] = [
      ['foo', false],
      ['123', true],
      [' bar ', false],
      ['123', true],
      [' baz', false],
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
    const join = (pieces: Piece[]) => {
      return pieces
        .map(([t]) => {
          return t
        })
        .join('')
    }
    expect(join(reviewArticleDetailsGetHighlightedText(s, keys))).toBe(s)
  })
})
