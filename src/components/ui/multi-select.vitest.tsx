// @vitest-environment happy-dom

import {createMemo, createResource, createSignal, Show, splitProps, startTransition, Suspense} from 'solid-js'
import {render} from 'solid-js/web'
import {afterEach, describe, expect, test} from 'vitest'

import {getIsSameMultiSelectOptionList, type MultiSelectOption} from './multi-select.tsx'

const yesOption = {label: 'Yes', value: 'yes'}
const noOption = {label: 'No', value: 'no'}

const waitForUpdates = () => {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
}

const getOptionLabels = (options: readonly MultiSelectOption[]) => {
  return options
    .map((option) => {
      return option.label
    })
    .join(', ')
}

const OptionLabels = (props: {options: readonly MultiSelectOption[]; title: Promise<string>}) => {
  const [local] = splitProps(props, ['options', 'title'])
  const [title] = createResource(() => {
    return local.title
  })
  const options = createMemo(
    () => {
      return local.options
    },
    undefined,
    {equals: getIsSameMultiSelectOptionList},
  )

  return <p>{`${title()}: ${getOptionLabels(options())}`}</p>
}

const renderOptionLabelsBehindTransition = (title: Promise<string>) => {
  const [options, setOptions] = createSignal<readonly MultiSelectOption[]>([yesOption])
  const [isVisible, setIsVisible] = createSignal(false)
  const container = document.createElement('div')
  document.body.appendChild(container)
  const dispose = render(() => {
    return (
      <Suspense fallback={<p>Loading</p>}>
        <Show when={isVisible()} fallback={<p>Idle</p>}>
          <OptionLabels options={options()} title={title} />
        </Show>
      </Suspense>
    )
  }, container)

  return {container, dispose, setIsVisible, setOptions}
}

describe('getIsSameMultiSelectOptionList', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  test('treats a missing previous list as changed', () => {
    expect(getIsSameMultiSelectOptionList(undefined, [])).toBe(false)
  })

  test('matches lists with the same values and labels in the same order', () => {
    expect(getIsSameMultiSelectOptionList([yesOption, noOption], [{...yesOption}, {...noOption}])).toBe(true)
  })

  test('detects a changed label, value, order, or length', () => {
    expect(getIsSameMultiSelectOptionList([yesOption], [{label: 'Ja', value: 'yes'}])).toBe(false)
    expect(getIsSameMultiSelectOptionList([yesOption], [{label: 'Yes', value: 'ja'}])).toBe(false)
    expect(getIsSameMultiSelectOptionList([yesOption, noOption], [noOption, yesOption])).toBe(false)
    expect(getIsSameMultiSelectOptionList([yesOption], [yesOption, noOption])).toBe(false)
  })

  test('keeps a memo created under a pending transition updating', async () => {
    const title = Promise.withResolvers<string>()
    const {container, dispose, setIsVisible, setOptions} = renderOptionLabelsBehindTransition(title.promise)

    try {
      void startTransition(() => {
        setIsVisible(true)
      })
      await waitForUpdates()

      expect(container.textContent).toBe('Idle')
      expect(() => {
        setOptions([yesOption, noOption])
      }).not.toThrow()

      title.resolve('Options')
      await waitForUpdates()
      await waitForUpdates()

      expect(container.textContent).toBe('Options: Yes, No')
    } finally {
      dispose()
    }
  })
})
