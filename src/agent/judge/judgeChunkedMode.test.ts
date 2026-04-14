import {expect, test} from 'bun:test'

import {getChunkParallelLimit} from '../judge.ts'
import {parseSinglePromptEvidence} from './parseSinglePromptEvidence.ts'
import {parseSinglePromptJudgment} from './parseSinglePromptJudgment.ts'

test('chunked mode schemas: evidence + final parse', () => {
  const evidenceJson = JSON.stringify({facts: ['fact 1'], quotes: ['verbatim quote']})
  const evidence = parseSinglePromptEvidence(evidenceJson)
  expect(evidence.facts).toEqual(['fact 1'])
  expect(evidence.quotes).toEqual(['verbatim quote'])

  const finalJson = JSON.stringify({answer: 'yes', explanation: 'because', quotes: ['verbatim quote']})
  const judgment = parseSinglePromptJudgment(finalJson, null)
  expect(judgment.answer).toBe('yes')
  expect(judgment.explanation).toBe('because')
  expect(judgment.quotes).toEqual(['verbatim quote'])
})

test('single prompt parser extracts JSON after thinking preamble', () => {
  const judgment = parseSinglePromptJudgment(
    'Thinking Process:\n\nI should answer with JSON.\n\n{"answer":"yes","explanation":"because","quotes":null}',
    null,
  )

  expect(judgment.answer).toBe('yes')
  expect(judgment.explanation).toBe('because')
  expect(judgment.quotes).toBeNull()
})

test('chunked mode uses provider cap when present and keeps configured fallback when absent', () => {
  const original = getChunkParallelLimit({chunkCount: 10, providerMaxInflightRequests: null})

  expect(getChunkParallelLimit({chunkCount: 10, providerMaxInflightRequests: 2})).toBe(2)
  expect(getChunkParallelLimit({chunkCount: 3, providerMaxInflightRequests: null})).toBe(3)
  expect(original).toBeGreaterThan(1)
})
