import {expect, test} from 'bun:test'

import {parseSinglePromptJudgment} from './parseSinglePromptJudgment.ts'

const enumPromptType = "'yes' | 'no' | 'maybe'"

test('recovers nested JSON stored in answer for enum prompts', () => {
  const inner = {
    answer: 'yes',
    explanation: 'The study evaluates a pharmacist intervention.',
    quotes: ['pre-to-post intervention study'],
  }
  const response = JSON.stringify({answer: JSON.stringify(inner), explanation: '', quotes: null})

  expect(parseSinglePromptJudgment(response, enumPromptType)).toEqual(inner)
})

test('recovers nested JSON stored in answer for open prompts', () => {
  const inner = {answer: 'custom answer', explanation: 'because', quotes: []}
  const response = JSON.stringify({answer: JSON.stringify(inner), explanation: '', quotes: null})

  expect(parseSinglePromptJudgment(response, null)).toEqual(inner)
})

test('keeps normal enum answers unchanged', () => {
  const response = JSON.stringify({answer: 'no', explanation: 'because', quotes: []})

  expect(parseSinglePromptJudgment(response, enumPromptType)).toEqual({
    answer: 'no',
    explanation: 'because',
    quotes: [],
  })
})

test('recovers nested answer for enum prompts when outer explanation is populated', () => {
  const inner = {answer: 'yes', explanation: 'inner explanation', quotes: ['inner quote']}
  const response = JSON.stringify({
    answer: JSON.stringify(inner),
    explanation: 'outer explanation',
    quotes: ['outer quote'],
  })

  expect(parseSinglePromptJudgment(response, enumPromptType)).toEqual(inner)
})

test('does not recover nested answer for open prompts when outer response already validates', () => {
  const inner = {answer: 'custom answer', explanation: 'inner explanation', quotes: ['inner quote']}
  const response = JSON.stringify({
    answer: JSON.stringify(inner),
    explanation: 'outer explanation',
    quotes: ['outer quote'],
  })

  expect(parseSinglePromptJudgment(response, null)).toEqual({
    answer: JSON.stringify(inner),
    explanation: 'outer explanation',
    quotes: ['outer quote'],
  })
})

test('does not recover nested answer when inner object does not validate prompt type', () => {
  const inner = {answer: 'include', explanation: 'because', quotes: []}
  const response = JSON.stringify({answer: JSON.stringify(inner), explanation: '', quotes: null})

  expect(() => {
    parseSinglePromptJudgment(response, enumPromptType)
  }).toThrow('answer must be')
})

test('does not recover nested answer when inner object is missing judgment keys', () => {
  const response = JSON.stringify({
    answer: JSON.stringify({answer: 'yes', explanation: 'missing quotes'}),
    explanation: '',
    quotes: null,
  })

  expect(() => {
    parseSinglePromptJudgment(response, enumPromptType)
  }).toThrow('answer must be')
})

test('does not recover nested answer when answer is not valid JSON', () => {
  const response = JSON.stringify({answer: '{"answer":"yes"', explanation: '', quotes: null})

  expect(() => {
    parseSinglePromptJudgment(response, enumPromptType)
  }).toThrow('answer must be')
})
