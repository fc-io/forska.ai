import {expect, test} from 'bun:test'

import {
  getHasComparisonProjectConflictResolutionCommentControlCharacter,
  removeComparisonProjectConflictResolutionCommentControlCharacters,
} from './comparisonProjectConflictResolutionComment.ts'

test('comments allow tab, newline and carriage return but no other control characters', () => {
  expect(getHasComparisonProjectConflictResolutionCommentControlCharacter('line one\r\nline\ttwo')).toBe(false)
  expect(getHasComparisonProjectConflictResolutionCommentControlCharacter("Reviewer's note -- ok 😀")).toBe(false)
  expect(getHasComparisonProjectConflictResolutionCommentControlCharacter('a\u0000b')).toBe(true)
  expect(getHasComparisonProjectConflictResolutionCommentControlCharacter('a\u001Fb')).toBe(true)
  expect(getHasComparisonProjectConflictResolutionCommentControlCharacter('a\u007Fb')).toBe(true)
  expect(removeComparisonProjectConflictResolutionCommentControlCharacters('a\u0000b\u0007c\td\r\ne')).toBe(
    'abc\td\r\ne',
  )
})
