import {expect, test} from 'bun:test'

import {
  getComparableModelNames,
  getRuntimeModelNamesForProvider,
  hasRuntimeModelMatch,
} from './providerRuntimeModelMatch.ts'

test('getComparableModelNames keeps unique trimmed model names', () => {
  expect(getComparableModelNames([' Qwen/Qwen3.5-122B-A10B ', null, 'Qwen/Qwen3.5-122B-A10B', ''])).toEqual([
    'Qwen/Qwen3.5-122B-A10B',
  ])
})

test('getRuntimeModelNamesForProvider returns runtime names for the matching provider', () => {
  expect(
    getRuntimeModelNamesForProvider({
      providerKind: 'sglang',
      runtime: {activeModelNames: ['Qwen/Qwen3.5-122B-A10B'], providerKind: 'sglang'},
    }),
  ).toEqual(['Qwen/Qwen3.5-122B-A10B'])
})

test('hasRuntimeModelMatch returns true when the selected model matches the runtime model', () => {
  expect(
    hasRuntimeModelMatch({
      candidateModelNames: ['Qwen/Qwen3.5-122B-A10B'],
      providerKind: 'sglang',
      runtime: {activeModelNames: ['Qwen/Qwen3.5-122B-A10B'], providerKind: 'sglang'},
    }),
  ).toBe(true)
})

test('hasRuntimeModelMatch returns false when the selected model does not match the runtime model', () => {
  expect(
    hasRuntimeModelMatch({
      candidateModelNames: ['Qwen/Qwen3.5-122B-A10B'],
      providerKind: 'sglang',
      runtime: {activeModelNames: ['Qwen/Qwen3.5-32B'], providerKind: 'sglang'},
    }),
  ).toBe(false)
})
