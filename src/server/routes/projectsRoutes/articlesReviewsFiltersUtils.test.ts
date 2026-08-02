import {expect, test} from 'bun:test'

import {
  extractSpecialValues,
  getFilterStrategy,
  isNumericType,
  parseArktypeOptions,
} from './articlesReviewsFiltersUtils.ts'

test('parseArktypeOptions handles quoted scalar unions and escaped values', () => {
  expect(parseArktypeOptions("'yes' | 'no' | \"maybe\"")).toEqual(['yes', 'no', 'maybe'])
  expect(parseArktypeOptions("'can\\'t tell' | \"line\\nfeed\"")).toEqual(["can't tell", 'line\nfeed'])
})

test('parseArktypeOptions handles boolean literals as fixed enum values', () => {
  expect(parseArktypeOptions('boolean')).toEqual(['true', 'false'])
  expect(parseArktypeOptions('true | false')).toEqual(['true', 'false'])
  expect(parseArktypeOptions("('yes' | 'no')[]")).toEqual(['yes', 'no'])
})

test('parseArktypeOptions rejects open strings, numeric types, and mixed open unions', () => {
  expect(parseArktypeOptions('string')).toBeNull()
  expect(parseArktypeOptions("string | 'not applicable'")).toBeNull()
  expect(parseArktypeOptions('number')).toBeNull()
  expect(parseArktypeOptions("string.integer | 'unknown'")).toBeNull()
  expect(parseArktypeOptions("Date | 'unknown'")).toBeNull()
})

test('numeric and special-value helpers ignore quoted numeric-looking enum values', () => {
  expect(isNumericType("'1' | '2'")).toBe(false)
  expect(isNumericType('1 | 2')).toBe(true)
  expect(getFilterStrategy("string.integer | 'unknown'")).toBe('numeric')
  expect(extractSpecialValues("string.integer | 'unknown' | 'not applicable'")).toEqual(['unknown', 'not applicable'])
})
