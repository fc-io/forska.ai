// @vitest-environment happy-dom

import {render} from 'solid-js/web'
import {afterEach, expect, test} from 'vitest'

import {ReviewJudgments} from './reviewJudgments.tsx'

afterEach(() => {
  document.body.innerHTML = ''
})

test('ReviewJudgments shows separate AI and Human summary values while keeping AI prompt detail in summary mode', () => {
  const container = document.createElement('div')
  document.body.appendChild(container)

  const dispose = render(() => {
    return (
      <ReviewJudgments
        humanJudgmentMode="summary"
        humanSummaryAnswer="no"
        llmSummaryAnswer="maybe"
        judgments={[
          {
            id: 'judgment-1',
            promptId: 'prompt-1',
            prompt: {id: 'prompt-1', originalText: 'Population prompt text', promptHeading: 'Population'},
            answeredOriginal: 'yes',
            explanation: 'Matched the population criteria',
            quotes: [],
          },
        ]}
        setArticleViewToShow={() => {}}
      />
    )
  }, container)

  expect(container.textContent).toContain('Include this study?')
  expect(container.textContent).toContain('AI')
  expect(container.textContent).toContain('Human')
  expect(container.textContent).toContain('Maybe')
  expect(container.textContent).toContain('No')
  expect(container.textContent).toContain('Population prompt text')
  expect(container.textContent).toContain('Matched the population criteria')
  expect(container.textContent).toContain('YES')

  dispose()
})

test('ReviewJudgments shows the full-text execution on the chunking line', () => {
  const container = document.createElement('div')
  document.body.appendChild(container)

  const dispose = render(() => {
    return (
      <ReviewJudgments
        judgments={[
          {
            id: 'judgment-chunked',
            promptId: 'prompt-1',
            prompt: {id: 'prompt-1', originalText: 'Chunked prompt'},
            answeredOriginal: 'yes',
            chunkCount: 4,
            chunkPlanHash: '0123456789abcdef',
            fullTextMode: 'chunked',
          },
          {
            id: 'judgment-single',
            promptId: 'prompt-2',
            prompt: {id: 'prompt-2', originalText: 'Single prompt'},
            answeredOriginal: 'no',
            chunkCount: null,
            chunkPlanHash: null,
            fullTextMode: 'single',
          },
          {
            id: 'judgment-none',
            promptId: 'prompt-3',
            prompt: {id: 'prompt-3', originalText: 'Plain prompt'},
            answeredOriginal: 'maybe',
            fullTextMode: null,
          },
        ]}
        setArticleViewToShow={() => {}}
      />
    )
  }, container)

  const chunkingLines = Array.from(container.querySelectorAll('div'))
    .map((element) => {
      return element.textContent ?? ''
    })
    .filter((text) => {
      return text.startsWith('Chunking: ')
    })

  expect(chunkingLines).toEqual([
    'Chunking: yes (full text in 4 parts, plan 01234567)',
    'Chunking: no (full text in one request)',
    'Chunking: no',
  ])

  dispose()
})

test('ReviewJudgments labels legacy no-images judgments and keeps one full text badge for the rest', () => {
  const container = document.createElement('div')
  document.body.appendChild(container)

  const dispose = render(() => {
    return (
      <ReviewJudgments
        judgments={[
          {
            id: 'judgment-legacy-no-images',
            promptId: 'prompt-1',
            prompt: {id: 'prompt-1', originalText: 'Legacy prompt'},
            answeredOriginal: 'yes',
            useAbstract: false,
            useFulltext: false,
            useFulltextNoImages: true,
            useTitle: false,
          },
          {
            id: 'judgment-full-text',
            promptId: 'prompt-2',
            prompt: {id: 'prompt-2', originalText: 'Full text prompt'},
            answeredOriginal: 'no',
            useAbstract: false,
            useFulltext: true,
            useFulltextNoImages: false,
            useTitle: false,
          },
        ]}
        setArticleViewToShow={() => {}}
      />
    )
  }, container)

  const contentLines = Array.from(container.querySelectorAll('div'))
    .map((element) => {
      return element.textContent ?? ''
    })
    .filter((text) => {
      return text.startsWith('Content:')
    })

  expect(contentLines).toEqual(['Content:TitleAbstractfull text (legacy, no images)', 'Content:TitleAbstractFull text'])

  dispose()
})

test('ReviewJudgments shows a refused prompt as a model refusal with its reason and model instead of a missing answer', () => {
  const container = document.createElement('div')
  document.body.appendChild(container)

  const dispose = render(() => {
    return (
      <ReviewJudgments
        judgments={[
          {
            id: 'placeholder:prompt-1',
            promptId: 'prompt-1',
            prompt: {id: 'prompt-1', originalText: 'Population prompt text', promptHeading: 'Population'},
            answeredOriginal: 'not answered',
            explanation: null,
            quotes: [],
            providerRefusal: {
              failureCode: 'claude_code_content_refusal',
              modelName: 'claude-opus-5-5',
              providerKind: 'claude-code',
              reason:
                "Claude Code content refusal (stop_reason=refusal): API Error: Opus 5's safeguards flagged this message",
              refusedAt: '2026-11-06T06:59:13.635Z',
            },
          },
          {
            id: 'judgment-2',
            promptId: 'prompt-2',
            prompt: {id: 'prompt-2', originalText: 'Design prompt text', promptHeading: 'Design'},
            answeredOriginal: 'yes',
            explanation: 'Randomised trial',
            quotes: [],
          },
        ]}
        setArticleViewToShow={() => {}}
      />
    )
  }, container)

  expect(container.textContent).toContain('MODEL REFUSED TO ANSWER')
  expect(container.textContent).toContain('Model: claude-opus-5-5')
  expect(container.textContent).toContain("Opus 5's safeguards flagged this message")
  expect(container.textContent).not.toContain('NOT ANSWERED')
  expect(container.textContent).toContain('YES')

  dispose()
})

test('ReviewJudgments shows a failed closeout as a failed model call with its code, reason and a resume hint', () => {
  const container = document.createElement('div')
  document.body.appendChild(container)

  const dispose = render(() => {
    return (
      <ReviewJudgments
        judgments={[
          {
            id: 'placeholder:prompt-1',
            promptId: 'prompt-1',
            prompt: {id: 'prompt-1', originalText: 'Intervention prompt text', promptHeading: 'Intervention'},
            answeredOriginal: 'not answered',
            explanation: null,
            quotes: [],
            providerFailure: {
              attemptCount: 3,
              failureCode: 'claude_code_request_failed',
              failureCount: 1,
              lastFailedAt: '2026-10-27T19:40:05.282Z',
              modelName: 'claude-opus-5-5',
              providerKind: 'claude-code',
              reason: 'Claude Code request failed: subtype=error_max_turns stderr=',
            },
          },
          {
            id: 'judgment-2',
            promptId: 'prompt-2',
            prompt: {id: 'prompt-2', originalText: 'Design prompt text', promptHeading: 'Design'},
            answeredOriginal: 'yes',
            explanation: 'Randomised trial',
            quotes: [],
          },
        ]}
        setArticleViewToShow={() => {}}
      />
    )
  }, container)

  expect(container.textContent).toContain('MODEL CALL FAILED')
  expect(container.textContent).toContain('Model: claude-opus-5-5')
  expect(container.textContent).toContain('claude_code_request_failed')
  expect(container.textContent).toContain('subtype=error_max_turns')
  expect(container.textContent).toContain('Resume the job to retry.')
  expect(container.textContent).not.toContain('NOT ANSWERED')
  expect(container.textContent).not.toContain('MODEL REFUSED TO ANSWER')
  expect(container.textContent).toContain('YES')

  dispose()
})
