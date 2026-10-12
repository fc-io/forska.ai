import {expect, test} from 'bun:test'

import {
  getHasComparisonProjectConflictResolutionCommentControlCharacter,
  getNormalizedComparisonProjectConflictComment,
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

test('normalized comments drop disallowed control characters and surrounding whitespace, and empty means none', () => {
  expect(getNormalizedComparisonProjectConflictComment('  before\u0000after\r\n\tline  ')).toBe('beforeafter\r\n\tline')
  expect(getNormalizedComparisonProjectConflictComment('\u0007\u0000')).toBeNull()
  expect(getNormalizedComparisonProjectConflictComment(' \u0007 \n ')).toBeNull()
  expect(getNormalizedComparisonProjectConflictComment(null)).toBeNull()
  expect(getNormalizedComparisonProjectConflictComment(undefined)).toBeNull()
})
