import {getDuckdbBackgroundRuntimeDiagnostics} from '../../utils/duckdbService.ts'
import {getCurrentServerRole} from '../../utils/serverRuntimeRole.ts'

export const adminInvestigateRoutesGetMaintenanceRuntimeDiagnostics = async () => {
  const processMemory = process.memoryUsage()

  return {
    duckdb: await getDuckdbBackgroundRuntimeDiagnostics(),
    processMemory: {
      arrayBuffersBytes: processMemory.arrayBuffers,
      externalBytes: processMemory.external,
      heapTotalBytes: processMemory.heapTotal,
      heapUsedBytes: processMemory.heapUsed,
      rssBytes: processMemory.rss,
    },
    role: getCurrentServerRole(),
    serverRole: process.env.SERVER_ROLE ?? null,
    pid: process.pid,
  }
}
