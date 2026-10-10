import {createSignal, Show} from 'solid-js'

import {
  comparisonProjectSearchTextMaxLength,
  getNormalizedComparisonProjectSearchText,
} from '../../../../../utils/comparisonProjectSearchText.ts'

type CompareProjectJudgmentsSearchFormProps = {appliedSearchText: string; onSubmit: (searchText: string) => void}

export const compareProjectJudgmentsSearchPlaceholder = 'Type a title, DOI or PMID and press Search'

export const CompareProjectJudgmentsSearchForm = (props: CompareProjectJudgmentsSearchFormProps) => {
  const [draftSearchText, setDraftSearchText] = createSignal<string | null>(null)
  const searchText = () => {
    return draftSearchText() ?? props.appliedSearchText
  }

  return (
    <form
      class="flex items-center gap-2"
      role="search"
      onSubmit={(event) => {
        event.preventDefault()
        props.onSubmit(getNormalizedComparisonProjectSearchText(searchText()))
        setDraftSearchText(null)
      }}
    >
      <label class="flex flex-col text-sm font-medium gap-1 w-full max-w-xl">
        <span>Search title</span>
        <input
          type="text"
          value={searchText()}
          maxLength={comparisonProjectSearchTextMaxLength}
          onInput={(event) => {
            setDraftSearchText(event.currentTarget.value)
          }}
          placeholder={compareProjectJudgmentsSearchPlaceholder}
          class="w-full px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
        />
      </label>
      <button type="submit" class="self-end h-10 px-4 py-2 rounded-md border bg-blue-600 text-white hover:bg-blue-700">
        Search
      </button>
      <Show when={props.appliedSearchText !== ''}>
        <button
          type="button"
          class="self-end h-10 px-4 py-2 rounded-md border bg-white text-gray-700 hover:bg-gray-50"
          onClick={() => {
            setDraftSearchText(null)
            props.onSubmit('')
          }}
        >
          Clear
        </button>
      </Show>
    </form>
  )
}
