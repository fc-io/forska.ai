import {createSignal, Show} from 'solid-js'

import {
  type ComparisonProjectConflictResolutionTransferArtifact,
  fetchComparisonProjectConflictResolutionExportArtifact,
} from '../../services/comparisonProjectsService'
import {Button} from '../ui/button'

type CompareProjectResolutionExportActionProps = {
  buttonClass?: string
  comparisonProjectId: string
  resolutionCount?: number
}

type DownloadJsonArtifactParams = {artifact: ComparisonProjectConflictResolutionTransferArtifact; filename: string}

type HandleExportResolutionsClickParams = {
  comparisonProjectId: string
  setExportError: (message: string | null) => void
  setIsExporting: (isExporting: boolean) => void
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

export const getExportResolutionsButtonLabel = (resolutionCount?: number) => {
  return typeof resolutionCount === 'number' && Number.isFinite(resolutionCount)
    ? `Export resolutions (${resolutionCount})`
    : 'Export resolutions'
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

export const CompareProjectResolutionExportAction = (props: CompareProjectResolutionExportActionProps) => {
  const [isExporting, setIsExporting] = createSignal(false)
  const [exportError, setExportError] = createSignal<string | null>(null)

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        class={props.buttonClass}
        disabled={isExporting()}
        onClick={() => {
          void handleExportResolutionsClick({
            comparisonProjectId: props.comparisonProjectId,
            setExportError,
            setIsExporting,
          })
        }}
      >
        <Show when={isExporting()} fallback={getExportResolutionsButtonLabel(props.resolutionCount)}>
          Exporting...
        </Show>
      </Button>
      <Show when={exportError()}>
        {(message) => {
          return <span class="max-w-xs text-xs text-red-600">{message()}</span>
        }}
      </Show>
    </>
  )
}
