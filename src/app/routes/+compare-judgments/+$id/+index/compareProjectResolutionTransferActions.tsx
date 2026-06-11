import {Show} from 'solid-js'

import {CompareProjectResolutionExportAction} from '../../../../../components/main/compareProjectResolutionExportAction'
import {Button} from '../../../../../components/ui/button'

type CompareProjectResolutionTransferActionsProps = {
  allowConflictResolution?: boolean | null
  comparisonProjectId: string
  resolutionCount?: number
}

export const compareProjectResolutionImportDisabledCopy =
  'Target comparison project must allow conflict resolution to import resolutions.'

export const getImportResolutionsHref = (comparisonProjectId: string) => {
  return `/compare-judgments/${encodeURIComponent(comparisonProjectId)}/import-resolutions`
}

export const CompareProjectResolutionTransferActions = (props: CompareProjectResolutionTransferActionsProps) => {
  return (
    <div class="flex flex-wrap items-center gap-2">
      <CompareProjectResolutionExportAction
        comparisonProjectId={props.comparisonProjectId}
        resolutionCount={props.resolutionCount}
      />
      <Show when={props.allowConflictResolution === true}>
        <Button as="a" href={getImportResolutionsHref(props.comparisonProjectId)} variant="outline" size="sm">
          Import resolutions
        </Button>
      </Show>
      <Show when={props.allowConflictResolution === false}>
        <div class="flex flex-col gap-1">
          <Button type="button" variant="outline" size="sm" disabled>
            Import resolutions
          </Button>
          <span class="max-w-xs text-xs text-gray-500">{compareProjectResolutionImportDisabledCopy}</span>
        </div>
      </Show>
    </div>
  )
}
