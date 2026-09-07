import {Show} from 'solid-js'

import {CompareProjectResolutionExportAction} from '../../../../../components/main/compareProjectResolutionExportAction.tsx'
import {Button} from '../../../../../components/ui/button.tsx'
import type {ComparisonProjectConflictResolutionExportRequest} from '../../../../../services/comparisonProjectsService.ts'

type CompareProjectResolutionExportSectionProps = {
  allowConflictResolution?: boolean | null
  comparisonProjectId: string
  exportRequest: ComparisonProjectConflictResolutionExportRequest
  resolutionCount?: number
}

export const CompareProjectResolutionExportSection = (props: CompareProjectResolutionExportSectionProps) => {
  return (
    <section class="rounded-lg bg-white p-6 shadow">
      <div class="flex flex-col gap-4 min-[720px]:flex-row min-[720px]:items-start min-[720px]:justify-between">
        <div class="max-w-3xl">
          <h2 class="text-lg font-semibold text-gray-900">Resolution transfer export</h2>
          <p class="mt-2 text-sm text-gray-600">
            This JSON export uses the filters above and is for exporting and importing resolutions between compare
            projects. It is not intended to be human-usable.
          </p>
        </div>
        <Show
          when={props.allowConflictResolution === true}
          fallback={
            <div class="flex flex-col gap-1">
              <Button type="button" variant="outline" size="sm" disabled>
                Export resolutions
              </Button>
              <span class="max-w-xs text-xs text-gray-500">
                Enable conflict resolution on this compare project before exporting resolutions.
              </span>
            </div>
          }
        >
          <CompareProjectResolutionExportAction
            comparisonProjectId={props.comparisonProjectId}
            exportRequest={props.exportRequest}
            resolutionCount={props.resolutionCount}
          />
        </Show>
      </div>
    </section>
  )
}
