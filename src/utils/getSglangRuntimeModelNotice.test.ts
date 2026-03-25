import {expect, test} from 'bun:test'

import {getSglangRuntimeModelNotice} from './getSglangRuntimeModelNotice.ts'

test('getSglangRuntimeModelNotice returns null for non-sglang providers', () => {
  expect(
    getSglangRuntimeModelNotice({
      candidateModelNames: ['gpt-4.1'],
      getMismatchMessage: (runtimeLabel) => {
        return runtimeLabel
      },
      providerKind: 'openai',
      runtime: {activeModelNames: ['Qwen/Qwen3.5-122B-A10B'], providerKind: 'sglang'},
    }),
  ).toBeNull()
})

test('getSglangRuntimeModelNotice returns info for matching sglang runtime model', () => {
  expect(
    getSglangRuntimeModelNotice({
      candidateModelNames: ['Qwen/Qwen3.5-122B-A10B'],
      getMismatchMessage: (runtimeLabel) => {
        return runtimeLabel
      },
      providerKind: 'sglang',
      runtime: {activeModelNames: ['Qwen/Qwen3.5-122B-A10B'], providerKind: 'sglang'},
    }),
  ).toEqual({message: 'Active SGLang runtime model: Qwen/Qwen3.5-122B-A10B.', tone: 'info'})
})

test('getSglangRuntimeModelNotice returns warning for mismatched sglang runtime model', () => {
  expect(
    getSglangRuntimeModelNotice({
      candidateModelNames: ['Qwen/Qwen3.5-122B-A10B'],
      getMismatchMessage: (runtimeLabel) => {
        return `Mismatch: ${runtimeLabel}`
      },
      providerKind: 'sglang',
      runtime: {activeModelNames: ['Qwen/Qwen3.5-32B'], providerKind: 'sglang'},
    }),
  ).toEqual({message: 'Mismatch: Qwen/Qwen3.5-32B', tone: 'warning'})
})
