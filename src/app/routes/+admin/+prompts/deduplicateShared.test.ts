import {expect, test} from 'bun:test'

import {getDuplicateGroupKey, getMergePromptIds} from './deduplicateShared'

test('getDuplicateGroupKey is stable across group order and position', () => {
  expect(getDuplicateGroupKey([{id: 'b'}, {id: 'a'}])).toBe('a|b')
  expect(getDuplicateGroupKey([{id: 'a'}, {id: 'b'}])).toBe('a|b')
  expect(getDuplicateGroupKey([{id: 'a'}, {id: 'c'}])).not.toBe('a|b')
})

test('getMergePromptIds returns the other prompts when the kept prompt is in the group', () => {
  expect(getMergePromptIds([{id: 'a'}, {id: 'b'}, {id: 'c'}], 'b')).toEqual(['a', 'c'])
})

test('getMergePromptIds refuses a kept prompt that is not part of the group', () => {
  expect(getMergePromptIds([{id: 'a'}, {id: 'b'}], 'z')).toBeNull()
  expect(getMergePromptIds([{id: 'a'}, {id: 'b'}], undefined)).toBeNull()
  expect(getMergePromptIds([], 'a')).toBeNull()
})
