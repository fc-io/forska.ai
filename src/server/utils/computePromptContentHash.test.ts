import {expect, test} from 'bun:test'
import {createHash} from 'crypto'

import {computePromptContentHash} from './computePromptContentHash'

test('computePromptContentHash matches the database normalization rules', () => {
  const hash = computePromptContentHash(' \nPrompt text\r\n', '  transformed  ', ' Title', '\tMeta ')
  const expectedNormalized = '\nPrompt text|transformed|Title|\tMeta'
  const expectedHash = createHash('md5').update(expectedNormalized).digest('hex')

  expect(hash).toBe(expectedHash)
})
