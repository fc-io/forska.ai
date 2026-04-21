import {Show} from 'solid-js'

import type {ComparisonProjectJudgmentsMetadata} from '../../../../../services/comparisonProjectsService.ts'

type CompareProjectExportMetadataProps = {comparisonProject: ComparisonProjectJudgmentsMetadata}

const getContentSettingsLabel = (contentVariants: Array<{label: string}>) => {
  return contentVariants.length > 0
    ? contentVariants
        .map((contentVariant) => {
          return contentVariant.label
        })
        .join(' · ')
    : 'none'
}

const getHumanJudgmentModeLabel = (humanJudgmentMode: 'prompt' | 'summary') => {
  return humanJudgmentMode === 'summary' ? 'Summary overall decisions' : 'Prompt-by-prompt decisions'
}

const getHumanComparisonLabel = (comparisonProject: ComparisonProjectJudgmentsMetadata) => {
  return comparisonProject.compareWithHumans
    ? getHumanJudgmentModeLabel(comparisonProject.humanJudgmentMode)
    : 'Not included'
}

const getSourceProjectsLabel = (comparisonProject: ComparisonProjectJudgmentsMetadata) => {
  return comparisonProject.sourceProjects.length > 0
    ? comparisonProject.sourceProjects
        .map((sourceProject) => {
          return sourceProject.name
        })
        .join(' · ')
    : 'None'
}

export const CompareProjectExportMetadata = (props: CompareProjectExportMetadataProps) => {
  return (
    <div class="rounded-lg bg-white p-6 shadow">
      <div class="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 class="text-lg font-semibold">{props.comparisonProject.name}</h2>
          <p class="text-sm text-gray-600">
            {props.comparisonProject.description?.trim() || 'No description provided.'}
          </p>
        </div>
        <Show
          when={props.comparisonProject.archived}
          fallback={
            <span class="inline-flex items-center rounded-full bg-green-100 px-3 py-1 text-xs font-medium text-green-800">
              Active
            </span>
          }
        >
          <span class="inline-flex items-center rounded-full bg-gray-200 px-3 py-1 text-xs font-medium text-gray-700">
            Archived
          </span>
        </Show>
      </div>
      <div class="grid gap-4 md:grid-cols-4">
        <div>
          <p class="text-xs font-medium uppercase tracking-wide text-gray-500">Compare Content</p>
          <p class="mt-2 text-sm text-gray-700">{getContentSettingsLabel(props.comparisonProject.contentVariants)}</p>
        </div>
        <div>
          <p class="text-xs font-medium uppercase tracking-wide text-gray-500">Prompts and Models</p>
          <p class="mt-2 text-sm text-gray-700">
            {props.comparisonProject.prompts.length} prompts · {props.comparisonProject.models.length} models
          </p>
        </div>
        <div>
          <p class="text-xs font-medium uppercase tracking-wide text-gray-500">Human Comparison</p>
          <p class="mt-2 text-sm text-gray-700">{getHumanComparisonLabel(props.comparisonProject)}</p>
          <Show when={props.comparisonProject.summarySourceProject}>
            {(summarySourceProject) => {
              return <p class="mt-1 text-xs text-gray-500">Summary source: {summarySourceProject().name}</p>
            }}
          </Show>
        </div>
        <div>
          <p class="text-xs font-medium uppercase tracking-wide text-gray-500">Included Projects</p>
          <p class="mt-2 text-sm text-gray-700">{getSourceProjectsLabel(props.comparisonProject)}</p>
        </div>
      </div>
    </div>
  )
}
