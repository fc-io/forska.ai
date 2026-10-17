import {useQuery} from '@tanstack/solid-query'
import {Show, splitProps} from 'solid-js'

import {apiClient} from '../../../services/apiClient.ts'
import {handleApiResponse} from '../../../services/utils/handleApiResponse.ts'
import {
  type FullTextChunkMaxPromptTokens,
  type FullTextChunkMode,
  type FullTextChunkPolicy,
  type FullTextFigureMode,
} from '../../../utils/fullTextStrategyOptions.ts'
import {
  type FullTextStrategyChoice,
  FullTextStrategyChoiceGroup,
} from './fullTextStrategySettings/fullTextStrategyChoiceGroup.tsx'
import {
  FullTextStrategyPreview,
  type FullTextStrategyPreviewData,
} from './fullTextStrategySettings/fullTextStrategyPreview.tsx'

export type FullTextStrategySelection = {
  chunkMode: FullTextChunkMode | null
  figureMode: FullTextFigureMode | null
  maxPromptTokens: FullTextChunkMaxPromptTokens | null
  useFulltext: boolean
}

type FullTextStrategySettingsProps = {
  disabled?: boolean
  lockedStrategy?: {id: string | null; label: string | null}
  onChange: (selection: FullTextStrategySelection) => void
  projectId?: string
  selection: FullTextStrategySelection
}

type ProjectFullTextSettings = {
  fullTextChunkPolicy?: FullTextChunkPolicy | null
  fullTextFigureMode?: FullTextFigureMode | null
  useFulltext: boolean
  useFulltextNoImages: boolean
}

const figureModeChoices: ReadonlyArray<FullTextStrategyChoice<FullTextFigureMode>> = [
  {description: 'Captions only. Figures are not sent.', label: 'None', value: 'none'},
  {
    description: 'Each figure as a text description written by the figure-description model.',
    label: 'Descriptions',
    value: 'descriptions',
  },
  {
    description: 'Figures as images, only for models that accept image input.',
    label: 'Native images',
    value: 'native_images',
  },
]

const maxPromptTokenChoices: ReadonlyArray<FullTextStrategyChoice<FullTextChunkMaxPromptTokens>> = [
  {label: '24k tokens', value: 24_000},
  {label: '48k tokens', value: 48_000},
  {label: '96k tokens', value: 96_000},
]

const chunkModeChoices: ReadonlyArray<FullTextStrategyChoice<FullTextChunkMode>> = [
  {description: 'Articles that do not fit are skipped.', label: 'Single call only', value: 'single_only'},
  {description: 'Articles that do not fit are judged in chunks, then merged.', label: 'Chunked', value: 'chunked'},
]

export const emptyFullTextStrategySelection: FullTextStrategySelection = {
  chunkMode: null,
  figureMode: null,
  maxPromptTokens: null,
  useFulltext: false,
}

export const getFullTextStrategySelectionFromProject = (
  project: ProjectFullTextSettings,
): FullTextStrategySelection => {
  const useFulltext = project.useFulltext || project.useFulltextNoImages

  return {
    chunkMode: useFulltext ? (project.fullTextChunkPolicy?.mode ?? null) : null,
    figureMode: useFulltext ? (project.fullTextFigureMode ?? (project.useFulltextNoImages ? 'none' : null)) : null,
    maxPromptTokens: useFulltext ? (project.fullTextChunkPolicy?.maxPromptTokens ?? null) : null,
    useFulltext,
  }
}

export const getFullTextChunkPolicyFromSelection = (
  selection: FullTextStrategySelection,
): FullTextChunkPolicy | null => {
  return selection.maxPromptTokens && selection.chunkMode
    ? {maxPromptTokens: selection.maxPromptTokens, mode: selection.chunkMode}
    : null
}

export const getFullTextStrategySelectionPayload = (selection: FullTextStrategySelection) => {
  return {
    fullTextChunkPolicy: selection.useFulltext ? getFullTextChunkPolicyFromSelection(selection) : null,
    fullTextFigureMode: selection.useFulltext ? selection.figureMode : null,
    useFulltext: selection.useFulltext,
  }
}

export const getFullTextSelectionError = (selection: FullTextStrategySelection) => {
  const missing = [
    selection.figureMode ? null : 'a figure mode',
    getFullTextChunkPolicyFromSelection(selection)
      ? null
      : 'a chunk policy (prompt size and what happens when an article does not fit)',
  ].filter((part): part is string => {
    return part !== null
  })

  return selection.useFulltext && missing.length > 0 ? `Full text needs ${missing.join(' and ')}.` : null
}

const fetchFullTextStrategyPreview = async (selection: FullTextStrategySelection, projectId: string | undefined) => {
  const response = await apiClient.api.projects['full-text-strategy-preview'].post({
    ...getFullTextStrategySelectionPayload(selection),
    ...(projectId ? {projectId} : {}),
  })

  return handleApiResponse<{data: FullTextStrategyPreviewData}>(response, 'Failed to resolve the full-text strategy')
    .data
}

export const FullTextStrategySettings = (props: FullTextStrategySettingsProps) => {
  const [local] = splitProps(props, ['disabled', 'lockedStrategy', 'onChange', 'projectId', 'selection'])
  const previewQuery = useQuery(() => {
    return {
      enabled: !local.disabled && (local.selection.useFulltext || Boolean(local.projectId)),
      queryFn: () => {
        return fetchFullTextStrategyPreview(local.selection, local.projectId)
      },
      queryKey: [
        'projects',
        'full-text-strategy-preview',
        local.projectId ?? null,
        local.selection.useFulltext,
        local.selection.figureMode,
        local.selection.maxPromptTokens,
        local.selection.chunkMode,
      ],
      suspense: false,
    }
  })
  const update = (patch: Partial<FullTextStrategySelection>) => {
    local.onChange({...local.selection, ...patch})
  }

  return (
    <div class="border border-input rounded-md p-3 space-y-3" data-testid="full-text-strategy-settings">
      <label class="flex items-start gap-3 cursor-pointer">
        <input
          type="checkbox"
          class="mt-1"
          checked={local.selection.useFulltext}
          disabled={local.disabled}
          onChange={(event) => {
            update({useFulltext: event.currentTarget.checked})
          }}
        />
        <div class="flex-1">
          <p class="text-sm font-medium text-gray-900">Use Full Text</p>
          <p class="text-xs text-gray-500 mt-0.5">
            Judge from the converted full text. Figure mode and chunk policy are required and recorded in the full-text
            strategy.
          </p>
        </div>
      </label>
      <Show when={local.selection.useFulltext}>
        <div class="space-y-3 pl-6">
          <FullTextStrategyChoiceGroup
            disabled={local.disabled}
            legend="Figure mode"
            name="full-text-figure-mode"
            options={figureModeChoices}
            value={local.selection.figureMode}
            onChange={(figureMode) => {
              update({figureMode})
            }}
          />
          <FullTextStrategyChoiceGroup
            disabled={local.disabled}
            legend="Prompt size per call"
            name="full-text-max-prompt-tokens"
            options={maxPromptTokenChoices}
            value={local.selection.maxPromptTokens}
            onChange={(maxPromptTokens) => {
              update({maxPromptTokens})
            }}
          />
          <FullTextStrategyChoiceGroup
            disabled={local.disabled}
            legend="When an article does not fit"
            name="full-text-chunk-mode"
            options={chunkModeChoices}
            value={local.selection.chunkMode}
            onChange={(chunkMode) => {
              update({chunkMode})
            }}
          />
        </div>
      </Show>
      <Show when={!local.disabled && (local.selection.useFulltext || local.projectId)}>
        <FullTextStrategyPreview
          data={previewQuery.data}
          isError={previewQuery.isError}
          isLoading={previewQuery.isLoading}
          showStrategy={local.selection.useFulltext}
        />
      </Show>
      <Show when={local.disabled && local.lockedStrategy?.id}>
        <p class="text-xs text-gray-700">
          Full-text strategy: <span data-testid="full-text-strategy-label">{local.lockedStrategy?.label}</span>{' '}
          <code class="text-[11px] text-muted-foreground" data-testid="full-text-strategy-id">
            {local.lockedStrategy?.id}
          </code>
        </p>
      </Show>
    </div>
  )
}
