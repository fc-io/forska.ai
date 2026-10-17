import {useQuery} from '@tanstack/solid-query'
import {createEffect, Show, splitProps} from 'solid-js'

import {apiClient} from '../../../services/apiClient.ts'
import {handleApiResponse} from '../../../services/utils/handleApiResponse.ts'
import {
  type FullTextChunkMaxPromptTokens,
  type FullTextChunkMode,
  type FullTextChunkPolicy,
  type FullTextFigureMode,
  fullTextStrategyErrorMessages,
} from '../../../utils/fullTextStrategyOptions.ts'
import {
  type FullTextStrategyChoice,
  FullTextStrategyChoiceGroup,
} from './fullTextStrategySettings/fullTextStrategyChoiceGroup.tsx'
import {
  FullTextStrategyPreview,
  type ProjectFullTextValidation,
} from './fullTextStrategySettings/fullTextStrategyPreview.tsx'

export type {ProjectFullTextValidation}

export type FullTextStrategySelection = {
  chunkMode: FullTextChunkMode | null
  figureMode: FullTextFigureMode | null
  maxPromptTokens: FullTextChunkMaxPromptTokens | null
  useFulltext: boolean
}

type FullTextStrategySettingsProps = {
  disabled?: boolean
  lockedStrategy?: {id: string | null; label: string | null}
  modelId: string
  onChange: (selection: FullTextStrategySelection) => void
  onValidationChange?: (validation: ProjectFullTextValidation | undefined) => void
  projectId?: string
  selection: FullTextStrategySelection
}

type ProjectFullTextValidationInput = {modelId: string | null; projectId?: string; selection: FullTextStrategySelection}

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
  const missingMessages: Array<string | null> = [
    selection.figureMode ? null : fullTextStrategyErrorMessages.figureModeMissing,
    getFullTextChunkPolicyFromSelection(selection) ? null : fullTextStrategyErrorMessages.chunkPolicyMissing,
  ]
  const missing = missingMessages.filter((part): part is string => {
    return part !== null
  })

  return selection.useFulltext && missing.length > 0 ? missing.join(' ') : null
}

export const getFullTextValidationBlocksSubmit = (
  selection: FullTextStrategySelection,
  validation: ProjectFullTextValidation | undefined,
) => {
  return selection.useFulltext && (validation?.errors.length ?? 0) > 0
}

const fetchProjectFullTextValidation = async ({modelId, projectId, selection}: ProjectFullTextValidationInput) => {
  const response = await apiClient.api.projects['full-text-validation'].post({
    ...getFullTextStrategySelectionPayload(selection),
    modelId: modelId || null,
    ...(projectId ? {projectId} : {}),
  })

  return handleApiResponse<{data: ProjectFullTextValidation}>(response, 'Failed to validate the full-text settings')
    .data
}

const useProjectFullTextValidationQuery = (input: () => ProjectFullTextValidationInput) => {
  return useQuery(() => {
    const {modelId, projectId, selection} = input()

    return {
      enabled: selection.useFulltext || Boolean(projectId),
      queryFn: () => {
        return fetchProjectFullTextValidation({modelId, projectId, selection})
      },
      queryKey: [
        'projects',
        'full-text-validation',
        projectId ?? null,
        modelId || null,
        selection.useFulltext,
        selection.figureMode,
        selection.maxPromptTokens,
        selection.chunkMode,
      ],
      suspense: false,
    }
  })
}

export const FullTextStrategySettings = (props: FullTextStrategySettingsProps) => {
  const [local] = splitProps(props, [
    'disabled',
    'lockedStrategy',
    'modelId',
    'onChange',
    'onValidationChange',
    'projectId',
    'selection',
  ])
  const validationQuery = useProjectFullTextValidationQuery(() => {
    return {modelId: local.modelId, projectId: local.projectId, selection: local.selection}
  })

  createEffect(() => {
    local.onValidationChange?.(validationQuery.data)
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
      <FullTextStrategyPreview
        data={validationQuery.data}
        isError={validationQuery.isError}
        isLoading={validationQuery.isLoading}
        showErrors={local.selection.useFulltext}
        showStrategy={local.selection.useFulltext && !local.disabled}
      />
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
