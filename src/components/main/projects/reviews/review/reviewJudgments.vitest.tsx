// @vitest-environment happy-dom

import {afterEach, expect, test} from 'vitest'
import {render} from 'solid-js/web'

import {ReviewJudgments} from './reviewJudgments.tsx'

afterEach(() => {
  document.body.innerHTML = ''
})

test('ReviewJudgments shows summary-vs-summary labels while keeping AI prompt detail in summary mode', () => {
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

  expect(container.textContent).toContain('Overall decision')
  expect(container.textContent).toContain('Population prompt text')
  expect(container.textContent).toContain('Matched the population criteria')
  expect(container.textContent).toContain('N')
  expect(container.textContent).toContain('M')

  dispose()
})
