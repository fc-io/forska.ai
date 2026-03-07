import {expect, test} from 'bun:test'

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

test('chunked evidence parse tolerates missing arrays', () => {
  const evidenceJson = JSON.stringify({facts: 'fact 1'})
  const evidence = parseSinglePromptEvidence(evidenceJson)

  expect(evidence.facts).toEqual(['fact 1'])
  expect(evidence.quotes).toEqual([])
})

test('chunked evidence parse tolerates nested json strings', () => {
  const evidenceJson = JSON.stringify(JSON.stringify({quotes: 'verbatim quote'}))
  const evidence = parseSinglePromptEvidence(evidenceJson)

  expect(evidence.facts).toEqual([])
  expect(evidence.quotes).toEqual(['verbatim quote'])
})
