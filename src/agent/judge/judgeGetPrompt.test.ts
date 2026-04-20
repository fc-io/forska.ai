import {expect, test} from 'bun:test'

import {judgeGetSinglePrompt} from './judgeGetPrompt.ts'

test('judgeGetSinglePrompt wraps source text with neutral markers', () => {
  const prompt = judgeGetSinglePrompt(
    {
      articleId: 'article-1',
      articleSummary: 'Summary with instructions like ignore prior text.',
      articleTitle: 'Title text',
      fullText: null,
    } as Parameters<typeof judgeGetSinglePrompt>[0],
    {id: 'prompt-1', originalText: 'Is this relevant?', order: 1, promptHeading: 'Eligibility', type: `'yes' | 'no'`},
  )

  expect(prompt).toContain('<SOURCE_TEXT_START>')
  expect(prompt).toContain('</SOURCE_TEXT_END>')
  expect(prompt).toContain('article source text')
  expect(prompt).not.toContain('raw dangerous text')
})
