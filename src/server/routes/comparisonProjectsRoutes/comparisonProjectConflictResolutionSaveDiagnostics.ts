import {freemem, totalmem} from 'node:os'

import {parseDuckdbMemoryLimitToMiB} from '../../utils/duckdbMemoryLimit.ts'
import {getDuckdbRuntimeConfig} from '../../utils/duckdbService.ts'
import {getRuntimeBuildInfo} from '../../utils/runtimeBuildInfo.ts'
import {getCurrentServerRole} from '../../utils/serverRuntimeRole.ts'

export type ConflictResolutionSaveBaseDiagnostic = {
  activeGeneration: number | null
  articleId: string
  comparisonProjectId: string
  isSummaryMode: boolean
  requestedValue: string
}

export const getConflictResolutionSaveMemorySnapshot = () => {
  const memory = process.memoryUsage()

  return {externalBytes: memory.external, heapUsedBytes: memory.heapUsed, rssBytes: memory.rss}
}

export const getConflictResolutionSaveRuntimeDiagnostic = () => {
  const duckdbRuntimeConfig = getDuckdbRuntimeConfig()
  const buildInfo = getRuntimeBuildInfo()

  return {
    commitSha: buildInfo.commitSha,
    commitShaSource: buildInfo.commitShaSource,
    duckdbCheckpointThreshold: duckdbRuntimeConfig.checkpointThreshold,
    duckdbMemoryLimit: duckdbRuntimeConfig.memoryLimit,
    duckdbMemoryLimitMiB: parseDuckdbMemoryLimitToMiB(duckdbRuntimeConfig.memoryLimit),
    duckdbTempDirectory: duckdbRuntimeConfig.tempDirectory,
    duckdbThreads: duckdbRuntimeConfig.threads,
    freeSystemMemoryBytes: freemem(),
    pid: process.pid,
    platform: process.platform,
    role: getCurrentServerRole(),
    totalSystemMemoryBytes: totalmem(),
  }
}

export const getConflictResolutionSaveDiagnostic = (params: ConflictResolutionSaveBaseDiagnostic) => {
  return {
    ...params,
    memory: getConflictResolutionSaveMemorySnapshot(),
    runtime: getConflictResolutionSaveRuntimeDiagnostic(),
  }
}

export const logConflictResolutionSavePhase = (
  phase: string,
  params: ConflictResolutionSaveBaseDiagnostic,
  extra: Record<string, unknown> = {},
) => {
  console.info('[comparison-projects] conflict-resolution save phase', {
    ...getConflictResolutionSaveDiagnostic(params),
    ...extra,
    phase,
  })
}

export const getConflictResolutionSaveErrorDiagnostic = (error: unknown) => {
  if (error instanceof Error) {
    return {message: error.message, name: error.name}
  }

  return {message: String(error), name: typeof error}
}
