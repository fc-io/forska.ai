// @vitest-environment happy-dom

import {render} from 'solid-js/web'
import {afterEach, expect, test} from 'vitest'

import {ReviewProviderRefusalBanner} from './reviewProviderRefusalBanner.tsx'

afterEach(() => {
  document.body.innerHTML = ''
})

test('ReviewProviderRefusalBanner asks for human screening with the refused share of prompts', () => {
  const container = document.createElement('div')
  document.body.appendChild(container)

  const dispose = render(() => {
    return <ReviewProviderRefusalBanner enabledPromptCount={6} refusedPromptCount={5} />
  }, container)

  expect(container.querySelector('[role="alert"]')).not.toBeNull()
  expect(container.textContent).toContain('Needs human screening')
  expect(container.textContent).toContain('The model refused to answer 5 of 6 prompts for this article.')

  dispose()
})

test('ReviewProviderRefusalBanner renders nothing when no prompt was refused', () => {
  const container = document.createElement('div')
  document.body.appendChild(container)

  const dispose = render(() => {
    return <ReviewProviderRefusalBanner enabledPromptCount={6} refusedPromptCount={0} />
  }, container)

  expect(container.textContent).toBe('')

  dispose()
})
