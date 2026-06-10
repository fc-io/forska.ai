import {createSignal, Show} from 'solid-js'

import {Button} from '../../../../../components/ui/button'
import {
  type ComparisonProjectConflictResolutionTransferArtifact,
  fetchComparisonProjectConflictResolutionExportArtifact,
} from '../../../../../services/comparisonProjectsService'

type CompareProjectResolutionTransferActionsProps = {
  allowConflictResolution?: boolean | null
  comparisonProjectId: string
}

type DownloadJsonArtifactParams = {artifact: ComparisonProjectConflictResolutionTransferArtifact; filename: string}

type HandleExportResolutionsClickParams = {
  comparisonProjectId: string
  setExportError: (message: string | null) => void
  setIsExporting: (isExporting: boolean) => void
}

export const compareProjectResolutionImportDisabledCopy =
  'Target comparison project must allow conflict resolution to import resolutions.'

export const getImportResolutionsHref = (comparisonProjectId: string) => {
  return `/compare-judgments/${encodeURIComponent(comparisonProjectId)}/import-resolutions`
}

export const downloadJsonArtifact = (params: DownloadJsonArtifactParams) => {
  const blob = new Blob([JSON.stringify(params.artifact, null, 2)], {type: 'application/json'})
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = params.filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

const getErrorMessage = (error: unknown) => {
  return error instanceof Error ? error.message : 'Failed to export resolutions'
}

export const handleExportResolutionsClick = async (params: HandleExportResolutionsClickParams) => {
  params.setIsExporting(true)
  params.setExportError(null)

  try {
    const result = await fetchComparisonProjectConflictResolutionExportArtifact(params.comparisonProjectId)
    downloadJsonArtifact(result)
  } catch (error) {
    params.setExportError(getErrorMessage(error))
  } finally {
    params.setIsExporting(false)
  }
}

export const CompareProjectResolutionTransferActions = (props: CompareProjectResolutionTransferActionsProps) => {
  const [isExporting, setIsExporting] = createSignal(false)
  const [exportError, setExportError] = createSignal<string | null>(null)

  return (
    <div class="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={isExporting()}
        onClick={() => {
          void handleExportResolutionsClick({
            comparisonProjectId: props.comparisonProjectId,
            setExportError,
            setIsExporting,
          })
        }}
      >
        <Show when={isExporting()} fallback="Export resolutions">
          Exporting...
        </Show>
      </Button>
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
      <Show when={exportError()}>
        {(message) => {
          return <span class="max-w-xs text-xs text-red-600">{message()}</span>
        }}
      </Show>
    </div>
  )
}
