import {writeProjectTransferCanonicalJsonArtifact} from '../../services/projectTransfer/projectTransferCanonicalJsonArtifact.ts'
import type {ProjectTransferProgressPayload} from '../../services/projectTransfer/projectTransferContracts.ts'
import {resolveProjectTransferTempWritablePath} from '../../services/projectTransfer/projectTransferPaths.ts'
import {getProjectTransferImportTempLayout} from '../../services/projectTransfer/projectTransferSession.ts'

export const writeImportProgressArtifact = async (sessionId: string, progress: ProjectTransferProgressPayload) => {
  const layout = getProjectTransferImportTempLayout(sessionId)
  const progressPath = resolveProjectTransferTempWritablePath({pathValue: layout.progressPath})

  await writeProjectTransferCanonicalJsonArtifact({filePath: progressPath, value: progress})
}
