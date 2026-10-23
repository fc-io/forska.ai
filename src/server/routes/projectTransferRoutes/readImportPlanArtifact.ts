import type {ProjectTransferImportPlanArtifact} from '../../services/projectTransfer/projectTransferAnalyze.ts'
import type {ProjectTransferSessionResponse} from '../../services/projectTransfer/projectTransferContracts.ts'
import {resolveProjectTransferTempWritablePath} from '../../services/projectTransfer/projectTransferPaths.ts'
import {getProjectTransferImportTempLayout} from '../../services/projectTransfer/projectTransferSession.ts'
import {getProjectTransferCurrentImportStagingLayout} from '../../services/projectTransfer/projectTransferStaging.ts'

export const readImportPlanArtifact = async (
  response: ProjectTransferSessionResponse,
): Promise<ProjectTransferImportPlanArtifact | null> => {
  const layout = getProjectTransferCurrentImportStagingLayout({
    layout: getProjectTransferImportTempLayout(response.id),
    progress: response.progress,
  })
  const planPath = resolveProjectTransferTempWritablePath({pathValue: layout.planPath})
  const planFile = globalThis.Bun.file(planPath)

  return (await planFile.exists()) ? (JSON.parse(await planFile.text()) as ProjectTransferImportPlanArtifact) : null
}
