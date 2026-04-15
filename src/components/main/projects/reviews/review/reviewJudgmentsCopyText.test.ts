import {expect, test} from 'bun:test'

import {getReviewJudgmentsCopyText} from './reviewJudgmentsCopyText.ts'

test('getReviewJudgmentsCopyText includes heading, overall decision, prompts, answers, explanation, and quotes', () => {
  const text = getReviewJudgmentsCopyText({
    humanJudgmentMode: 'summary',
    humanSummaryAnswer: 'no',
    llmSummaryAnswer: 'maybe',
    judgments: [
      {
        prompt: {id: 'prompt-1', originalText: 'Population prompt text', promptHeading: 'Population'},
        answeredOriginal: 'yes',
        explanation: 'Matched the population criteria',
        quotes: ['Quoted line'],
      },
    ],
  })

  expect(text).toContain('LLM assessment (1)')
  expect(text).toContain('Include this study?')
  expect(text).toContain('AI: Maybe')
  expect(text).toContain('Human: No')
  expect(text).toContain('Prompt heading: Population')
  expect(text).toContain('Prompt: Population prompt text')
  expect(text).toContain('-------')
  expect(text).toContain('AI answer: YES')
  expect(text).toContain('Explanation: Matched the population criteria')
  expect(text).toContain('Quote: "Quoted line"')
})

test('getReviewJudgmentsCopyText includes prompt mode human answers', () => {
  const text = getReviewJudgmentsCopyText({
    humanJudgmentMode: 'prompt',
    humanAnswersByPrompt: {
      'prompt-1': [
        {userName: 'Alice', answer: 'no'},
        {userName: 'Bob', answer: 'yes'},
      ],
    },
    judgments: [
      {
        promptId: 'prompt-1',
        prompt: {originalText: 'Intervention prompt text'},
        answeredOriginalAsArray: ['yes', 'maybe'],
      },
    ],
  })

  expect(text).toContain('LLM assessment (1)')
  expect(text).toContain('Prompt: Intervention prompt text')
  expect(text).toContain('-------')
  expect(text).toContain('AI answer: YES, MAYBE')
  expect(text).toContain('Human (Alice): no')
  expect(text).toContain('Human (Bob): yes')
})
