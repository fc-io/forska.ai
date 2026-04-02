import {expect, test} from 'bun:test'

import {formatFirstJudgeRequestLog} from './judge.ts'

test('formatFirstJudgeRequestLog serializes first-request logs as JSON with preview metadata', () => {
  const output = formatFirstJudgeRequestLog({
    judgmentsJobId: 'job-1',
    articleId: 'article-1',
    promptId: 'prompt-1',
    baseURL: 'http://localhost:3000',
    modelName: 'Qwen/Qwen3.5-27B',
    requestConfig: {temperature: 0.1, maxCompletionTokens: 2000},
    systemPromptPreview: {
      text: 'You are a helpful deep research assistant.',
      originalLength: 41,
      truncated: false,
    },
    userPromptPreview: {
      text: '## article_title\n\nNote: Between <DANGEROUS_TEXT_START>',
      originalLength: 12000,
      truncated: true,
    },
  })

  const parsed = JSON.parse(output) as {
    normalizedModelName: string
    request: {
      max_completion_tokens: number
      messages: {system: string; user: string}
      preview: {
        systemOriginalLength: number
        systemTruncated: boolean
        userOriginalLength: number
        userTruncated: boolean
      }
      temperature: number
    }
  }

  expect(parsed.normalizedModelName).toBe('Qwen/Qwen3.5-27B')
  expect(parsed.request.temperature).toBe(0.1)
  expect(parsed.request.max_completion_tokens).toBe(2000)
  expect(parsed.request.messages.system).toBe('You are a helpful deep research assistant.')
  expect(parsed.request.messages.user).toContain('<DANGEROUS_TEXT_START>')
  expect(parsed.request.preview.systemOriginalLength).toBe(41)
  expect(parsed.request.preview.systemTruncated).toBe(false)
  expect(parsed.request.preview.userOriginalLength).toBe(12000)
  expect(parsed.request.preview.userTruncated).toBe(true)
})

test('formatFirstJudgeRequestLog normalizes legacy relative model paths', () => {
  const output = formatFirstJudgeRequestLog({
    judgmentsJobId: 'job-2',
    articleId: 'article-2',
    promptId: 'prompt-2',
    baseURL: 'http://localhost:3000',
    modelName: './models/local-model',
    requestConfig: {temperature: 0.2, maxCompletionTokens: 512},
    systemPromptPreview: {text: 'sys', originalLength: 3, truncated: false},
    userPromptPreview: {text: 'user', originalLength: 4, truncated: false},
  })

  expect(JSON.parse(output).normalizedModelName).toBe('/models/local-model')
})
