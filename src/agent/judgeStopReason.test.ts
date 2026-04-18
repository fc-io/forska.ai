import {expect, test} from 'bun:test'

import {getStopReasonAdjustedErrorMessage} from './judge.ts'

test('annotates JSON parse failures that hit max_tokens stop reason', () => {
  expect(
    getStopReasonAdjustedErrorMessage({errorMessage: 'JSON Parse error: Unexpected EOF', stopReason: 'max_tokens'}),
  ).toBe('JSON Parse error: Unexpected EOF (provider stop_reason=max_tokens; response likely truncated at output cap)')
})

test('leaves non-parse failures unchanged', () => {
  expect(
    getStopReasonAdjustedErrorMessage({
      errorMessage: 'Invalid quotes: not substrings of record text',
      stopReason: 'max_tokens',
    }),
  ).toBe('Invalid quotes: not substrings of record text')
})
