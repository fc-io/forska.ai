// @vitest-environment happy-dom

import {createSignal} from 'solid-js'
import {render} from 'solid-js/web'
import {afterEach, describe, expect, test, vi} from 'vitest'

import {CompareProjectJudgmentsSearchForm} from './compareProjectJudgmentsSearchForm.tsx'

const renderSearchForm = (initialAppliedSearchText: string) => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const [appliedSearchText, setAppliedSearchText] = createSignal(initialAppliedSearchText)
  const onSubmit = vi.fn((searchText: string) => {
    setAppliedSearchText(searchText)
  })
  const dispose = render(() => {
    return <CompareProjectJudgmentsSearchForm appliedSearchText={appliedSearchText()} onSubmit={onSubmit} />
  }, container)
  const getInput = () => {
    return container.querySelector('input') as HTMLInputElement
  }
  const getButton = (label: string) => {
    return Array.from(container.querySelectorAll('button')).find((button) => {
      return button.textContent === label
    })
  }

  return {container, dispose, getButton, getInput, onSubmit, setAppliedSearchText}
}

describe('CompareProjectJudgmentsSearchForm', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  test('applies the typed search only on submit, normalized', () => {
    const form = renderSearchForm('')

    try {
      expect(form.container.textContent).toContain('Search title')
      expect(form.getButton('Clear')).toBeUndefined()

      form.getInput().value = '  Metformin   糖尿病 '
      form.getInput().dispatchEvent(new Event('input', {bubbles: true}))
      expect(form.onSubmit).not.toHaveBeenCalled()

      form.container.querySelector('form')?.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}))
      expect(form.onSubmit).toHaveBeenCalledWith('Metformin 糖尿病')
      expect(form.getButton('Clear')).toBeDefined()
    } finally {
      form.dispose()
    }
  })

  test('clear resets the input and applies an empty search', () => {
    const form = renderSearchForm('metformin')

    try {
      expect(form.getInput().value).toBe('metformin')

      form.getButton('Clear')?.click()
      expect(form.onSubmit).toHaveBeenCalledWith('')
      expect(form.getInput().value).toBe('')
      expect(form.getButton('Clear')).toBeUndefined()
    } finally {
      form.dispose()
    }
  })

  test('follows an applied search that changes from outside, such as URL state', () => {
    const form = renderSearchForm('')

    try {
      form.setAppliedSearchText('aspirin')
      expect(form.getInput().value).toBe('aspirin')
    } finally {
      form.dispose()
    }
  })
})
