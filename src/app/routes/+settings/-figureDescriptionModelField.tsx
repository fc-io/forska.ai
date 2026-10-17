import {useQuery} from '@tanstack/solid-query'
import {For, Show, splitProps} from 'solid-js'

import {apiClient} from '../../../services/apiClient'
import {handleApiResponse} from '../../../services/utils/handleApiResponse'

export type FigureDescriptionModelOption = {
  capabilitySource: string
  id: string
  label: string
  providerConnectionId: string
  providerKind: string
}

type FigureDescriptionModelOptionsResponse = {data: FigureDescriptionModelOption[]}

export const figureDescriptionModelsQueryKey = ['figure-description-models'] as const

const fetchFigureDescriptionModels = async (): Promise<FigureDescriptionModelOption[]> => {
  const response = await apiClient.api.users['figure-description-models'].get()
  const result = handleApiResponse<FigureDescriptionModelOptionsResponse>(
    response,
    'Failed to load image-capable models',
  )

  return result.data ?? []
}

const getQueryErrorMessage = (error: unknown) => {
  return error instanceof Error ? error.message : 'Failed to load image-capable models'
}

export const FigureDescriptionModelField = (props: {onChange: (value: string) => void; value: string}) => {
  const [local] = splitProps(props, ['onChange', 'value'])
  const optionsQuery = useQuery(() => {
    return {
      queryKey: figureDescriptionModelsQueryKey,
      queryFn: fetchFigureDescriptionModels,
      staleTime: 60_000,
      refetchOnWindowFocus: false,
    }
  })
  const isSelectedModelUnavailable = () => {
    return (
      local.value !== ''
      && optionsQuery.isSuccess
      && !(optionsQuery.data ?? []).some((option) => {
        return option.id === local.value
      })
    )
  }

  return (
    <div>
      <label for="figure-description-model" class="block text-sm font-medium text-gray-700 mb-2">
        Figure-description model
      </label>
      <select
        id="figure-description-model"
        value={local.value}
        disabled={optionsQuery.isLoading}
        onInput={(event) => {
          local.onChange(event.currentTarget.value)
        }}
        class="w-full px-3 py-3 border border-gray-300 rounded-md bg-white text-gray-900 sm:text-sm"
      >
        <option value="" selected={local.value === ''}>
          None (figure mode Descriptions is unavailable)
        </option>
        <Show when={isSelectedModelUnavailable()}>
          <option value={local.value} selected>
            Unavailable model {local.value}
          </option>
        </Show>
        <For each={optionsQuery.data ?? []}>
          {(option) => {
            return (
              <option value={option.id} selected={option.id === local.value}>
                {option.label}
              </option>
            )
          }}
        </For>
      </select>
      <Show when={optionsQuery.isLoading}>
        <p class="mt-2 text-xs text-gray-500">Loading image-capable models...</p>
      </Show>
      <Show when={optionsQuery.isError}>
        <p class="mt-2 text-xs text-red-600">{getQueryErrorMessage(optionsQuery.error)}</p>
      </Show>
      <Show when={isSelectedModelUnavailable()}>
        <p class="mt-2 text-xs text-amber-700">
          The saved figure-description model is disabled or no longer accepts image input. Choose another model or None.
        </p>
      </Show>
      <p class="mt-2 text-xs text-gray-500">
        Describes each converted figure for projects with figure mode Descriptions. Only enabled models whose capability
        record accepts image input are listed; set image input on the Providers page.
      </p>
    </div>
  )
}
