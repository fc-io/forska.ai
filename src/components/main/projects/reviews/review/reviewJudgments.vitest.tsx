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
