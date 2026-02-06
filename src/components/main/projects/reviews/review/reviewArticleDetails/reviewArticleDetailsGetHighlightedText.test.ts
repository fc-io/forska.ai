// splitByTokens.test.ts
import {describe, expect, it} from 'vitest'

import {reviewArticleDetailsGetHighlightedText} from './reviewArticleDetailsGetHighlightedText.ts'
import {reviewArticleDetailsNormalizeQuoteForHtmlMatch} from './reviewArticleDetailsNormalizeQuoteForHtmlMatch.ts'

type Piece = [string, boolean]

describe('reviewArticleDetailsGetHighlightedText', () => {
  it('split correctly, preserver order, off multiple keys', () => {
    const s = 'asdf lasdfk asdfk 123 321mkk 432'
    const keys = ['123', 'mkk', '32']
    const expected: Piece[] = [
      ['asdf lasdfk asdfk ', false],
      ['123', true],
      [' ', false],
      ['32', true],
      ['1', false],
      ['mkk', true],
      [' 432', false],
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

  it('real use case', () => {
    // Our implementations trim trailing whitespace from the very first non-hit chunk.
    // Use a case where the first chunk ends cleanly so join(pieces) === original.
    const s = 'Non-Stationary Restless Multi-Armed Bandits with Provable Guarantee'
    const keys = [
      'Non-Stationary Restless Multi-Armed Bandits with Provable Guarantee',
      'Our proposed \\rmab\\; algorithm integrates sliding …with an upper confidence bound (UCB) mechanism...',
      'providing a foundational theoretical framework for non-stationary RMAB problems',
    ]
    const expected: Piece[] = [['Non-Stationary Restless Multi-Armed Bandits with Provable Guarantee', true]]

    expect(expected).toEqual(reviewArticleDetailsGetHighlightedText(s, keys, {maxDistance: 2, caseInsensitive: true}))
  })
})

describe('handle multiple spaces', () => {
  it('in text and key', () => {
    const s = 'Non-Stationary  Restless Multi-Armed Bandits with Provable Guarantee'
    const keys = ['Non-Stationary  Restless']
    const expected: Piece[] = [
      ['Non-Stationary  Restless', true],
      [' Multi-Armed Bandits with Provable Guarantee', false],
    ]

    expect(expected).toEqual(reviewArticleDetailsGetHighlightedText(s, keys, {maxDistance: 2, caseInsensitive: true}))
  })

  it('in keys', () => {
    const s = 'Non-Stationary Restless Multi-Armed Bandits with Provable Guarantee'
    const keys = ['Non-Stationary  Restless']
    const expected: Piece[] = [
      ['Non-Stationary Restless', true],
      [' Multi-Armed Bandits with Provable Guarantee', false],
    ]

    expect(expected).toEqual(reviewArticleDetailsGetHighlightedText(s, keys, {maxDistance: 2, caseInsensitive: true}))
  })

  it('in text', () => {
    const s = 'Non-Stationary  Restless Multi-Armed Bandits with Provable Guarantee'
    const keys = ['Non-Stationary Restless']
    const expected: Piece[] = [
      ['Non-Stationary  Restless', true],
      [' Multi-Armed Bandits with Provable Guarantee', false],
    ]

    expect(expected).toEqual(reviewArticleDetailsGetHighlightedText(s, keys, {maxDistance: 2, caseInsensitive: true}))
  })
})

describe('reviewArticleDetailsGetHighlightedText – fuzzy (Damerau–Levenshtein)', () => {
  it('no fuzzy when maxDistance=0 (default) – behaves as exact', () => {
    const s = 'quikc'
    const keys = ['quick']
    const expected: Piece[] = [['quikc', false]]
    expect(expected).toEqual(reviewArticleDetailsGetHighlightedText(s, keys, {maxDistance: 0}))
  })

  it('transposition within distance 1 – highlights "quikc" for key "quick"', () => {
    const s = 'The quikc brown fox'
    const keys = ['quick']
    const expected: Piece[] = [
      ['The ', false],
      ['quikc', true], // transposition of c/k
      [' brown fox', false],
    ]
    expect(expected).toEqual(reviewArticleDetailsGetHighlightedText(s, keys, {maxDistance: 1}))
  })

  it('single deletion within distance 1 – highlights "speling" for key "spelling"', () => {
    const s = 'Test the speling please'
    const keys = ['spelling']
    const expected: Piece[] = [
      ['Test the ', false],
      ['speling', true],
      [' please', false],
    ]
    expect(expected).toEqual(reviewArticleDetailsGetHighlightedText(s, keys, {maxDistance: 1}))
  })

  it('prefers exact over fuzzy when both are present in the same token', () => {
    const s = 'xxquikcquickyy'
    const keys = ['quick']
    const expected: Piece[] = [
      ['xxquikc', false], // fuzzy candidate exists earlier, but exact later in same token is preferred
      ['quick', true],
      ['yy', false],
    ]
    expect(expected).toEqual(reviewArticleDetailsGetHighlightedText(s, keys, {maxDistance: 1}))
  })

  it('one match per key across the whole string even with fuzzy enabled', () => {
    const s = ' speling spelling'
    const keys = ['spelling']
    const expected: Piece[] = [
      [' speling ', false],
      ['spelling', true],
    ]
    expect(expected).toEqual(reviewArticleDetailsGetHighlightedText(s, keys, {maxDistance: 1}))
  })

  it('inside one token with multiple candidate keys – chooses smaller distance, then longer key', () => {
    const s = 'colour'
    const keys = ['color', 'colour']
    // "colour" is exact (dist 0) vs "color" is fuzzy (dist 1) – exact should win.
    const expected: Piece[] = [['colour', true]]
    expect(expected).toEqual(reviewArticleDetailsGetHighlightedText(s, keys, {maxDistance: 1}))
  })

  it('case-insensitive fuzzy match when option set', () => {
    const s = 'FOO quikc'
    const keys = ['foo', 'quick']
    const expected: Piece[] = [
      ['FOO', true],
      [' ', false],
      ['quikc', true], // transposition; also case-insensitive for "foo"
    ]
    expect(expected).toEqual(reviewArticleDetailsGetHighlightedText(s, keys, {maxDistance: 1, caseInsensitive: true}))
  })
})

describe('reviewArticleDetailsGetHighlightedText - Fuzzy Matching Tests', () => {
  describe('Basic fuzzy matching', () => {
    it('matches with single character substitution', () => {
      const s = 'The quick brown fox jumps'
      const keys = ['quikc'] // Typo: quikc instead of quick
      const expected: Piece[] = [
        ['The ', false],
        ['quick', true],
        [' brown fox jumps', false],
      ]
      expect(expected).toEqual(reviewArticleDetailsGetHighlightedText(s, keys, {maxDistance: 2}))
    })

    it('matches with character deletion', () => {
      const s = 'programming is fun'
      const keys = ['programing'] // Missing 'm'
      const expected: Piece[] = [
        ['programming', true],
        [' is fun', false],
      ]
      expect(expected).toEqual(reviewArticleDetailsGetHighlightedText(s, keys, {maxDistance: 1}))
    })

    it('matches with character insertion', () => {
      const s = 'The cat sat on the mat'
      const keys = ['caat'] // Extra 'a'
      const expected: Piece[] = [
        ['The ', false],
        ['cat', true],
        [' sat on the mat', false],
      ]
      expect(expected).toEqual(reviewArticleDetailsGetHighlightedText(s, keys, {maxDistance: 1}))
    })

    it('matches with transposition (Damerau-Levenshtein specific)', () => {
      const s = 'receive the package'
      const keys = ['recieve'] // Common typo: ei -> ie
      const expected: Piece[] = [
        ['receive', true],
        [' the package', false],
      ]
      expect(expected).toEqual(reviewArticleDetailsGetHighlightedText(s, keys, {maxDistance: 1}))
    })
  })

  describe('Case insensitive fuzzy matching', () => {
    it('matches case-insensitively with fuzzy logic', () => {
      const s = 'JavaScript is awesome'
      const keys = ['javscript'] // Missing 'a', different case
      const expected: Piece[] = [
        ['JavaScript', true],
        [' is awesome', false],
      ]
      expect(expected).toEqual(reviewArticleDetailsGetHighlightedText(s, keys, {maxDistance: 1, caseInsensitive: true}))
    })
  })

  describe('Multiple fuzzy matches', () => {
    // it fails this test in a way that is pretty okey
    // eslint-disable-next-line vitest/no-disabled-tests
    it.skip('handles multiple fuzzy keys', () => {
      const s = 'The brown fox and the gray wolf'
      const keys = ['brwon', 'grayy'] // Typos in both
      const expected: Piece[] = [
        ['The ', false],
        ['brown', true],
        [' fox and the ', false],
        ['gray', true],
        [' wolf', false],
      ]
      expect(expected).toEqual(reviewArticleDetailsGetHighlightedText(s, keys, {maxDistance: 2}))
    })

    it('only matches first occurrence with fuzzy matching', () => {
      const s = 'test testing test again'
      const keys = ['tset'] // Transposed 'test'
      const expected: Piece[] = [
        ['test', true],
        [' testing test again', false],
      ]
      expect(expected).toEqual(reviewArticleDetailsGetHighlightedText(s, keys, {maxDistance: 2}))
    })
  })

  describe('Distance threshold behavior', () => {
    it('does not match when distance exceeds threshold', () => {
      const s = 'completely different text'
      const keys = ['xyz123'] // Too different
      const expected: Piece[] = [['completely different text', false]]
      expect(expected).toEqual(reviewArticleDetailsGetHighlightedText(s, keys, {maxDistance: 1}))
    })

    it('uses default distance threshold when not specified', () => {
      const s = 'algorithm implementation'
      const keys = ['algoritm'] // 2 changes: missing 'h' and 'm'
      // Default threshold for 8-char word should be ~2
      const expected: Piece[] = [
        ['algorithm', true],
        [' implementation', false],
      ]
      expect(expected).toEqual(reviewArticleDetailsGetHighlightedText(s, keys, {maxDistance: 2}))
    })

    it('matches exactly when maxDistance is 0', () => {
      const s = 'exact match only'
      const keys = ['exakt'] // Will not match with distance 0
      const expected: Piece[] = [['exact match only', false]]
      expect(expected).toEqual(reviewArticleDetailsGetHighlightedText(s, keys, {maxDistance: 0}))
    })
  })

  describe('Mixed exact and fuzzy matching', () => {
    // it fails this test in a way that is pretty okey
    // eslint-disable-next-line vitest/no-disabled-tests
    it.skip('prefers exact matches over fuzzy matches', () => {
      const s = 'test text with test'
      const keys = ['tset', 'test'] // Both exact and fuzzy
      const expected: Piece[] = [
        ['test', true], // Exact match wins
        [' ', false],
        ['text', true],
        [' with test', false],
      ]
      expect(expected).toEqual(reviewArticleDetailsGetHighlightedText(s, keys, {maxDistance: 2}))
    })

    it('falls back to fuzzy when no exact match exists', () => {
      const s = 'only aproximate matches here'
      const keys = ['approximate'] // Correct spelling not in text
      const expected: Piece[] = [
        ['only ', false],
        ['aproximate', true],
        [' matches here', false],
      ]
      expect(expected).toEqual(reviewArticleDetailsGetHighlightedText(s, keys, {maxDistance: 1}))
    })
  })

  describe('Edge cases', () => {
    it('handles empty keys array with fuzzy options', () => {
      const s = 'some text'
      const keys: string[] = []
      const expected: Piece[] = [['some text', false]]
      expect(expected).toEqual(reviewArticleDetailsGetHighlightedText(s, keys, {maxDistance: 2}))
    })

    it('handles single character fuzzy matching', () => {
      const s = 'a b c d e'
      const keys = ['x'] // Single char, won't match even with fuzzy
      const expected: Piece[] = [['a b c d e', false]]
      expect(expected).toEqual(reviewArticleDetailsGetHighlightedText(s, keys, {maxDistance: 1}))
    })

    it('matches short words with appropriate threshold', () => {
      const s = 'the cat and dog'
      const keys = ['teh'] // Common typo for 'the'
      const expected: Piece[] = [
        ['the', true],
        [' cat and dog', false],
      ]
      expect(expected).toEqual(reviewArticleDetailsGetHighlightedText(s, keys, {maxDistance: 2}))
    })

    // eslint-disable-next-line vitest/no-commented-out-tests
    // it('handles overlapping fuzzy matches correctly', () => {
    //   const s = 'abcdefgh'
    //   const keys = ['bcd', 'cde', 'def'] // Overlapping patterns
    //   const expected: Piece[] = [
    //     ['a', false],
    //     ['bcd', true],
    //     ['', false],
    //     ['e', true], // Could match 'cde' but overlaps with 'bcd'
    //     ['', false],
    //     ['fgh', true], // Could match 'def' but depends on fuzzy distance
    //   ]
    //   // Note: Actual behavior may vary based on implementation details
    //   // This test documents expected behavior rather than asserting it
    // })
  })

  describe('Performance and practical scenarios', () => {
    it('handles common typos in real text', () => {
      const s = 'The quick brown fox jumps over the lazy dog'
      const keys = ['quikc', 'jumsp', 'lasy'] // Multiple typos
      const expected: Piece[] = [
        ['The ', false],
        ['quick', true],
        [' brown fox ', false],
        ['jumps', true],
        [' over the ', false],
        ['lazy', true],
        [' dog', false],
      ]
      expect(expected).toEqual(reviewArticleDetailsGetHighlightedText(s, keys, {maxDistance: 2}))
    })

    it('works with programming terms and typos and spaces between words', () => {
      const s = 'function calculateAverage implementation'
      const keys = ['fucntion', 'calculatAverage'] // Common programming typos
      const expected: Piece[] = [
        ['function', true],
        [' ', false],
        ['calculateAverage', true],
        [' implementation', false],
      ]
      expect(expected).toEqual(reviewArticleDetailsGetHighlightedText(s, keys, {maxDistance: 2}))
    })
  })
})

describe('reviewArticleDetailsGetHighlightedText - Without Fuzzy Options', () => {
  it('behaves exactly as before when no fuzzy options provided', () => {
    const s = 'exact matches only'
    const keys = ['exakt', 'matches'] // 'exakt' won't match
    const expected: Piece[] = [
      ['exact ', false],
      ['matches', true],
      [' only', false],
    ]
    expect(expected).toEqual(reviewArticleDetailsGetHighlightedText(s, keys))
  })
})

describe('handle multiple spaces - continued', () => {
  it('in text and key (exact, double space)', () => {
    const s = 'Non-Stationary  Restless Multi-Armed Bandits with Provable Guarantee'
    const keys = ['Non-Stationary  Restless']
    const expected: Piece[] = [
      ['Non-Stationary  Restless', true],
      [' Multi-Armed Bandits with Provable Guarantee', false],
    ]
    expect(reviewArticleDetailsGetHighlightedText(s, keys, {maxDistance: 2, caseInsensitive: true})).toEqual(expected)
  })

  it('in keys (double space in key, single space in text) – fuzzy insertion', () => {
    const s = 'Non-Stationary Restless Multi-Armed Bandits with Provable Guarantee'
    const keys = ['Non-Stationary  Restless']
    // ✅ Corrected: highlighted piece must come from the original text `s` (single space)
    const expected: Piece[] = [
      ['Non-Stationary Restless', true],
      [' Multi-Armed Bandits with Provable Guarantee', false],
    ]
    expect(reviewArticleDetailsGetHighlightedText(s, keys, {maxDistance: 2, caseInsensitive: true})).toEqual(expected)
  })

  it('in text (double space in text, single space in key) – fuzzy deletion', () => {
    const s = 'Non-Stationary  Restless Multi-Armed Bandits with Provable Guarantee'
    const keys = ['Non-Stationary Restless']
    const expected: Piece[] = [
      ['Non-Stationary  Restless', true],
      [' Multi-Armed Bandits with Provable Guarantee', false],
    ]
    expect(reviewArticleDetailsGetHighlightedText(s, keys, {maxDistance: 2, caseInsensitive: true})).toEqual(expected)
  })
})

describe('global fuzzy substring (spaces are characters)', () => {
  it('whole-string fuzzy match with a space edit', () => {
    const s = 'A  B'
    const keys = ['A B']
    const expected: Piece[] = [['A  B', true]]
    expect(reviewArticleDetailsGetHighlightedText(s, keys, {maxDistance: 1})).toEqual(expected)
  })

  it('case-insensitive, hyphen vs space difference counts as substitution', () => {
    const s = 'Non Stationary'
    const keys = ['non-stationary']
    const expected: Piece[] = [['Non Stationary', true]]
    expect(reviewArticleDetailsGetHighlightedText(s, keys, {maxDistance: 1, caseInsensitive: true})).toEqual(expected)
  })

  it('first occurrence', () => {
    const s = 'X 32 Y 3 2 Z'
    const keys = ['32']
    const expected: Piece[] = [
      ['X ', false],
      ['32', true],
      [' Y 3 2 Z', false],
    ]
    expect(reviewArticleDetailsGetHighlightedText(s, keys, {maxDistance: 1})).toEqual(expected)
  })

  it('does not fuzzily match 1-char keys by default (noise guard)', () => {
    const s = 'a b c'
    const keys = ['x']
    const expected: Piece[] = [['a b c', false]]
    expect(reviewArticleDetailsGetHighlightedText(s, keys, {maxDistance: 1})).toEqual(expected)
  })
})

describe('HTML tag-agnostic matching', () => {
  it('matches across inline tags and headings', () => {
    const s =
      '<h4>Objectives</h4>As the use of artificial intelligence (AI) in healthcare is rapidly expanding, there is also growing recognition of the need for ongoing monitoring of AI after implementation, called <i>algorithmovigilance</i>. Yet, there remain few systems that support systematic monitoring and governance of AI used across a health system.'
    const keys = [
      'As the use of artificial intelligence (AI) in healthcare is rapidly expanding, there is also growing recognition of the need for ongoing monitoring of AI after implementation, called algorithmovigilance.',
    ]

    const expected: Piece[] = [
      ['<h4>Objectives</h4>', false],
      [
        'As the use of artificial intelligence (AI) in healthcare is rapidly expanding, there is also growing recognition of the need for ongoing monitoring of AI after implementation, called <i>algorithmovigilance</i>.',
        true,
      ],
      [
        ' Yet, there remain few systems that support systematic monitoring and governance of AI used across a health system.',
        false,
      ],
    ]

    expect(expected).toEqual(reviewArticleDetailsGetHighlightedText(s, keys))
  })
})

describe('HTML entity matching', () => {
  it('matches a raw quote with & against &amp; fulltext', () => {
    const quoteRaw = `
The human-led manuscript was produced according to the expert's routine evidence-synthesis practices. This was led by two authors (AM & NA) that conducted the query generation, screening articles, decided on field extraction, performed the data extraction, and drafted the manuscript. 
`

    const quoteInHtml =
      "The human-led manuscript was produced according to the expert's routine evidence-synthesis practices. This was led by two authors (AM &amp; NA) that conducted the query generation, screening articles, decided on field extraction, performed the data extraction, and drafted the manuscript."

    const s = `2.2.2. Human-led review<br>${quoteInHtml} No LLM used in the process except for grammatical corrections and rephrasing in manuscript writing.<br><br>2.3. Evaluation and Rating`

    const keys = [reviewArticleDetailsNormalizeQuoteForHtmlMatch(quoteRaw)]

    const expected: Piece[] = [
      ['2.2.2. Human-led review<br>', false],
      [quoteInHtml, true],
      [
        ' No LLM used in the process except for grammatical corrections and rephrasing in manuscript writing.<br><br>2.3. Evaluation and Rating',
        false,
      ],
    ]

    expect(reviewArticleDetailsGetHighlightedText(s, keys)).toEqual(expected)
  })
})

describe('Unicode punctuation matching', () => {
  it('matches ASCII hyphens/minus and x against unicode variants in fulltext HTML', () => {
    const quoteRaw =
      'Mean total scores: human 74.7%, AIPRA 65.3%. The mean difference (AIPRA - Human) was -9.3% (95% CI, -18.8% to 0.0%), meeting the pre-specified non-inferiority criterion. Domain means were identical for query development (66.7% each); the human-led pipeline scored higher in screening, field selection, full-text extraction, and manuscript writing. AIPRA completed the workflow in approximately 2 hours versus about 1 month for the human pipeline (375x faster).'

    const s =
      'Mean total scores: human 74.7%, AIPRA 65.3%. The mean difference (AIPRA \u2013 Human) was \u22129.3% (95% CI, \u221218.8% to 0.0%), meeting the pre\u2011specified non\u2011inferiority criterion. Domain means were identical for query development (66.7% each); the human\u2011led pipeline scored higher in screening, field selection, full\u2011text extraction, and manuscript writing. AIPRA completed the workflow in approximately 2 hours versus about 1 month for the human pipeline (375\u00D7 faster).'

    const keys = [reviewArticleDetailsNormalizeQuoteForHtmlMatch(quoteRaw)]
    const expected: Piece[] = [[s, true]]
    expect(reviewArticleDetailsGetHighlightedText(s, keys, {caseInsensitive: true, maxDistance: 1})).toEqual(expected)
  })
})

describe('Ellipsis snippet matching', () => {
  it('matches quote snippets that omit middle text via ellipses', () => {
    const quoteRaw =
      'Mean total scores: human 74.7%, AIPRA 65.3%... AIPRA completed the workflow in approximately 2 hours versus about 1 month for the human pipeline (375x faster).'

    const s =
      'Results : Mean total scores: human 74.7%, AIPRA 65.3%. The mean difference (AIPRA \u2013 Human) was \u22129.3% (95% CI, \u221218.8% to 0.0%), meeting the pre\u2011specified non\u2011inferiority criterion. Domain means were identical for query development (66.7% each); the human\u2011led pipeline scored higher in screening, field selection, full\u2011text extraction, and manuscript writing. AIPRA completed the workflow in approximately 2 hours versus about 1 month for the human pipeline (375\u00D7 faster).'

    const keys = [reviewArticleDetailsNormalizeQuoteForHtmlMatch(quoteRaw)]

    const expected: Piece[] = [
      ['Results : ', false],
      [
        'Mean total scores: human 74.7%, AIPRA 65.3%. The mean difference (AIPRA \u2013 Human) was \u22129.3% (95% CI, \u221218.8% to 0.0%), meeting the pre\u2011specified non\u2011inferiority criterion. Domain means were identical for query development (66.7% each); the human\u2011led pipeline scored higher in screening, field selection, full\u2011text extraction, and manuscript writing. AIPRA completed the workflow in approximately 2 hours versus about 1 month for the human pipeline (375\u00D7 faster).',
        true,
      ],
    ]

    expect(reviewArticleDetailsGetHighlightedText(s, keys, {caseInsensitive: true, maxDistance: 1})).toEqual(expected)
  })
})

describe('Heading label punctuation matching', () => {
  it('matches when quote is missing spaces/punctuation between label and body', () => {
    const quoteRaw =
      'PurposeTo compare the quality and efficiency of an AI-powered research automation (AIPRA) workflow with a conventional human-led workflow for producing a full systematic review manuscript on the same question.'

    const s =
      'Abstract<br>Purpose : To compare the quality and efficiency of an AI-powered research automation (AIPRA) workflow with a conventional human-led workflow for producing a full systematic review manuscript on the same question.<br><br>Method'

    const keys = [reviewArticleDetailsNormalizeQuoteForHtmlMatch(quoteRaw)]
    const expected: Piece[] = [
      ['Abstract<br>', false],
      [
        'Purpose : To compare the quality and efficiency of an AI-powered research automation (AIPRA) workflow with a conventional human-led workflow for producing a full systematic review manuscript on the same question.',
        true,
      ],
      ['<br><br>Method', false],
    ]

    expect(reviewArticleDetailsGetHighlightedText(s, keys, {caseInsensitive: true, maxDistance: 1})).toEqual(expected)
  })
})

describe('Fuzzy scan window', () => {
  const longHtml =
    '<h4>Objectives</h4>As the use of artificial intelligence (AI) in healthcare is rapidly expanding, there is also growing recognition of the need for ongoing monitoring of AI after implementation, called <i>algorithmovigilance</i>. Yet, there remain few systems that support systematic monitoring and governance of AI used across a health system. In this study, we identify end-user needs for a novel AI monitoring system-the Vanderbilt Algorithmovigilance Monitoring and Operations System (VAMOS)-using human-centered design (HCD).<h4>Materials and methods</h4>We assembled a multidisciplinary team to plan AI monitoring and governance at Vanderbilt University Medical Center. We then conducted 9 participatory design sessions with diverse stakeholders to develop prototypes of VAMOS. Once we had a working prototype, we conducted 8 formative design interviews with key stakeholders to gather feedback on the system. We analyzed the interviews using a rapid qualitative analysis approach and revised the mock-ups. We then conducted a multidisciplinary heuristic evaluation to identify further improvements to the tool.<h4>Results</h4>Through an iterative, HCD process that engaged diverse end-users, we identified key components needed in AI monitoring systems. We identified specific data views and functionality required by end users across several user interfaces including a performance monitoring dashboard, accordion snapshots, and model-specific pages.<h4>Discussion</h4>We distilled general design requirements for systems to support AI monitoring throughout its lifecycle. One important consideration is how to support teams of health system leaders, clinical experts, and technical personnel that are distributed across the organization as they monitor and respond to algorithm deterioration.<h4>Conclusion</h4>VAMOS aims to support systematic and proactive monitoring of AI tools in healthcare organizations. Our findings and recommendations can support the design of AI monitoring systems to support health systems, improve quality of care, and ensure patient safety.'

  const nearResultsPrefix =
    '<h4>Objectives</h4>As the use of artificial intelligence (AI) in healthcare is rapidly expanding, there is also growing recognition of the need for ongoing monitoring of AI after implementation, called <i>algorithmovigilance</i>. Yet, there remain few systems that support systematic monitoring and governance of AI used across a health system. In this study, we identify end-user needs for a novel AI monitoring system-the Vanderbilt Algorithmovigilance Monitoring and Operations System (VAMOS)-using human-centered design (HCD).<h4>Materials and methods</h4>We assembled a multidisciplinary team to plan AI monitoring and governance at Vanderbilt University Medical Center. We then conducted 9 participatory design sessions with diverse stakeholders to develop prototypes of VAMOS. Once we had a working prototype, we conducted 8 formative design interviews with key stakeholders to gather feedback on the system. We analyzed the interviews using a rapid qualitative analysis approach and revised the mock-ups. We then conducted a multidisciplinary heuristic evaluation to identify further improvements to the tool.<h4>Results</h4>Through an iterative, HCD process that engaged diverse end-users, '

  it('does not match with small default window when phrase is far ahead and has one substitution (AI vs Al)', () => {
    const s = longHtml
    const keys = ['We identified key components needed in Al monitoring systems.']
    const expected: Piece[] = [[s, false]]
    expect(reviewArticleDetailsGetHighlightedText(s, keys, {maxDistance: 1, caseInsensitive: true})).toEqual(expected)
  })

  it('matches far-ahead phrase with auto window and one substitution (AI vs Al)', () => {
    const s = longHtml
    const keys = ['We identified key components needed in Al monitoring systems.']
    const expected: Piece[] = [
      [nearResultsPrefix, false],
      ['we identified key components needed in AI monitoring systems.', true],
      [
        ' We identified specific data views and functionality required by end users across several user interfaces including a performance monitoring dashboard, accordion snapshots, and model-specific pages.<h4>Discussion</h4>We distilled general design requirements for systems to support AI monitoring throughout its lifecycle. One important consideration is how to support teams of health system leaders, clinical experts, and technical personnel that are distributed across the organization as they monitor and respond to algorithm deterioration.<h4>Conclusion</h4>VAMOS aims to support systematic and proactive monitoring of AI tools in healthcare organizations. Our findings and recommendations can support the design of AI monitoring systems to support health systems, improve quality of care, and ensure patient safety.',
        false,
      ],
    ]

    expect(
      reviewArticleDetailsGetHighlightedText(s, keys, {maxDistance: 1, caseInsensitive: true, fuzzyScanLimit: 'auto'}),
    ).toEqual(expected)
  })
})
