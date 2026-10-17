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
