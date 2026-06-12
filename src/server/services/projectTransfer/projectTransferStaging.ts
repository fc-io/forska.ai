import {copyFile, cp, mkdir, readdir, readFile, rm} from 'node:fs/promises'
import {dirname} from 'node:path'

import type {
  ProjectTransferImportAnalysisArtifact,
  ProjectTransferImportPlanArtifact,
} from './projectTransferAnalyze.ts'
import type {ProjectTransferStagingProgressPayload} from './projectTransferContracts.ts'
import {getProjectTransferCanonicalJson, getProjectTransferSha256Checksum} from './projectTransferFingerprint.ts'
import {resolveProjectTransferTempWritablePath} from './projectTransferPaths.ts'
import type {ProjectTransferImportTempLayout, ProjectTransferProgressPayload} from './projectTransferSession.ts'

type RuntimePathOptions = {cwd?: string; envValues?: Record<string, string | undefined>}

export type ProjectTransferImportStagingLayout = ProjectTransferImportTempLayout & {
  stagingRevision: number
  stagingRootPath: string
}

type ProjectTransferStagingArtifactName = 'analysis' | 'manifest' | 'plan'

const projectTransferStagingDirectoryName = 'staging'
const projectTransferStagingRevisionPrefix = 'revision-'

const projectTransferStagingArtifactPaths = {
  analysis: 'analysisPath',
  manifest: 'manifestPath',
  plan: 'planPath',
} as const satisfies Record<ProjectTransferStagingArtifactName, keyof ProjectTransferImportStagingLayout>

const isNonNegativeInteger = (value: unknown) => {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

const assertProjectTransferStagingRevision = (stagingRevision: number) => {
  if (!isNonNegativeInteger(stagingRevision)) {
    throw new Error('Project transfer stagingRevision must be a non-negative integer')
  }
}

const getProjectTransferStagingRootPath = (layout: ProjectTransferImportTempLayout) => {
  return `${layout.rootPath}/${projectTransferStagingDirectoryName}`
}

const getProjectTransferStagingRevisionName = (stagingRevision: number) => {
  assertProjectTransferStagingRevision(stagingRevision)

  return `${projectTransferStagingRevisionPrefix}${stagingRevision}`
}

const getProjectTransferStagingRevisionFromName = (name: string) => {
  if (!name.startsWith(projectTransferStagingRevisionPrefix)) {
    return null
  }

  const revision = Number(name.slice(projectTransferStagingRevisionPrefix.length))

  return isNonNegativeInteger(revision) ? revision : null
}

export const getProjectTransferImportStagingLayout = ({
  layout,
  stagingRevision,
}: {
  layout: ProjectTransferImportTempLayout
  stagingRevision: number
}): ProjectTransferImportStagingLayout => {
  const stagingRootPath = `${getProjectTransferStagingRootPath(layout)}/${getProjectTransferStagingRevisionName(
    stagingRevision,
  )}`

  return {
    ...layout,
    analysisPath: `${stagingRootPath}/analysis.json`,
    extractedPath: `${stagingRootPath}/extracted`,
    manifestPath: `${stagingRootPath}/manifest.json`,
    planPath: `${stagingRootPath}/plan.json`,
    stagingRevision,
    stagingRootPath,
  }
}

export const getProjectTransferProgressStagingRevision = (
  progress: ProjectTransferProgressPayload | null | undefined,
) => {
  const topLevelRevision = progress?.stagingRevision
  const nestedRevision = progress?.staging?.stagingRevision ?? progress?.staging?.currentRevision
  const revision = isNonNegativeInteger(topLevelRevision) ? topLevelRevision : nestedRevision

  return isNonNegativeInteger(revision) ? revision : null
}

export const getProjectTransferCurrentImportStagingLayout = ({
  layout,
  progress,
}: {
  layout: ProjectTransferImportTempLayout
  progress: ProjectTransferProgressPayload | null | undefined
}) => {
  const stagingRevision = getProjectTransferProgressStagingRevision(progress)

  return stagingRevision === null ? layout : getProjectTransferImportStagingLayout({layout, stagingRevision})
}

const getProjectTransferPlanStagingRevision = (plan: ProjectTransferImportPlanArtifact) => {
  return isNonNegativeInteger(plan.stagingRevision) ? plan.stagingRevision : null
}

export const validateProjectTransferReviewedPlanStagingRevision = ({
  plan,
  progress,
}: {
  plan: ProjectTransferImportPlanArtifact
  progress: ProjectTransferProgressPayload | null | undefined
}) => {
  const currentStagingRevision = getProjectTransferProgressStagingRevision(progress)
  const reviewedStagingRevision = getProjectTransferPlanStagingRevision(plan)

  if (currentStagingRevision === null && reviewedStagingRevision === null) {
    return {ok: true as const}
  }

  if (currentStagingRevision === null) {
    return {error: 'Project transfer current stagingRevision is unavailable', ok: false as const}
  }

  return currentStagingRevision === reviewedStagingRevision
    ? {ok: true as const}
    : {error: 'Project transfer reviewed plan stagingRevision is stale', ok: false as const}
}

const readArtifactBytes = async ({
  layout,
  name,
  runtimeOptions,
}: {
  layout: ProjectTransferImportStagingLayout
  name: ProjectTransferStagingArtifactName
  runtimeOptions: RuntimePathOptions
}) => {
  const pathKey = projectTransferStagingArtifactPaths[name]
  const pathValue = layout[pathKey]
  const resolvedPath = resolveProjectTransferTempWritablePath({...runtimeOptions, pathValue})

  return new Uint8Array(await readFile(resolvedPath))
}

const getArtifactMetadata = async ({
  layout,
  runtimeOptions,
}: {
  layout: ProjectTransferImportStagingLayout
  runtimeOptions: RuntimePathOptions
}) => {
  const entries = await Promise.all(
    (Object.keys(projectTransferStagingArtifactPaths) as ProjectTransferStagingArtifactName[]).map(async (name) => {
      const bytes = await readArtifactBytes({layout, name, runtimeOptions})

      return [name, {byteLength: bytes.byteLength, checksumSha256: getProjectTransferSha256Checksum(bytes)}] as const
    }),
  )

  return entries.reduce<{artifactByteLengths: Record<string, number>; artifactChecksums: Record<string, string>}>(
    (metadata, [name, value]) => {
      return {
        artifactByteLengths: {...metadata.artifactByteLengths, [name]: value.byteLength},
        artifactChecksums: {...metadata.artifactChecksums, [name]: value.checksumSha256},
      }
    },
    {artifactByteLengths: {}, artifactChecksums: {}},
  )
}

const assertCanonicalMatch = (left: unknown, right: unknown, label: string) => {
  if (getProjectTransferCanonicalJson(left) !== getProjectTransferCanonicalJson(right)) {
    throw new Error(`Project transfer staging ${label} mismatch`)
  }
}

const assertStagingArtifacts = ({
  analysis,
  layout,
  plan,
}: {
  analysis: ProjectTransferImportAnalysisArtifact
  layout: ProjectTransferImportStagingLayout
  plan: ProjectTransferImportPlanArtifact
}) => {
  const planBlockerCount = plan.summary.blockers?.length ?? plan.blockers.length

  if (analysis.stagingRevision !== layout.stagingRevision || plan.stagingRevision !== layout.stagingRevision) {
    throw new Error('Project transfer stagingRevision artifact mismatch')
  }

  if (analysis.planRevision !== plan.planRevision) {
    throw new Error('Project transfer staging planRevision artifact mismatch')
  }

  if (plan.summary.blockerCount !== planBlockerCount) {
    throw new Error('Project transfer staging blocker count mismatch')
  }

  assertCanonicalMatch(analysis.packageCounts, plan.packageCounts, 'packageCounts')
  assertCanonicalMatch(plan.summary.packageCounts ?? plan.packageCounts, plan.packageCounts, 'summary packageCounts')
}

export const verifyProjectTransferStagingRevision = async ({
  analysis,
  layout,
  plan,
  runtimeOptions,
}: {
  analysis: ProjectTransferImportAnalysisArtifact
  layout: ProjectTransferImportStagingLayout
  plan: ProjectTransferImportPlanArtifact
  runtimeOptions: RuntimePathOptions
}): Promise<ProjectTransferStagingProgressPayload> => {
  assertStagingArtifacts({analysis, layout, plan})

  const artifactMetadata = await getArtifactMetadata({layout, runtimeOptions})

  return {
    ...artifactMetadata,
    blockerCount: plan.summary.blockerCount,
    currentRevision: layout.stagingRevision,
    packageCounts: plan.packageCounts,
    packageFingerprint: plan.packageFingerprint,
    path: layout.stagingRootPath,
    planRevision: plan.planRevision,
    stagedPackage: analysis.stagedPackage,
    stagingRevision: layout.stagingRevision,
    warningCount: plan.summary.warningCount,
  }
}

const copyStagingFile = async ({
  fromPathValue,
  toPathValue,
  ...runtimeOptions
}: RuntimePathOptions & {fromPathValue: string; toPathValue: string}) => {
  const fromPath = resolveProjectTransferTempWritablePath({...runtimeOptions, pathValue: fromPathValue})
  const toPath = resolveProjectTransferTempWritablePath({...runtimeOptions, pathValue: toPathValue})
  await mkdir(dirname(toPath), {recursive: true})
  await copyFile(fromPath, toPath)
}

export const mirrorProjectTransferStagingRevisionToLegacyLayout = async ({
  layout,
  runtimeOptions,
  stagingLayout,
}: {
  layout: ProjectTransferImportTempLayout
  runtimeOptions: RuntimePathOptions
  stagingLayout: ProjectTransferImportStagingLayout
}) => {
  const extractedPath = resolveProjectTransferTempWritablePath({...runtimeOptions, pathValue: layout.extractedPath})
  const stagingExtractedPath = resolveProjectTransferTempWritablePath({
    ...runtimeOptions,
    pathValue: stagingLayout.extractedPath,
  })

  await rm(extractedPath, {force: true, recursive: true})
  await mkdir(dirname(extractedPath), {recursive: true})
  await cp(stagingExtractedPath, extractedPath, {recursive: true})
  await Promise.all([
    copyStagingFile({...runtimeOptions, fromPathValue: stagingLayout.analysisPath, toPathValue: layout.analysisPath}),
    copyStagingFile({...runtimeOptions, fromPathValue: stagingLayout.manifestPath, toPathValue: layout.manifestPath}),
    copyStagingFile({...runtimeOptions, fromPathValue: stagingLayout.planPath, toPathValue: layout.planPath}),
  ])
}

export const getProjectTransferProgressWithStaging = ({
  progress,
  publishedAt,
  staging,
}: {
  progress: ProjectTransferProgressPayload
  publishedAt: Date
  staging: ProjectTransferStagingProgressPayload
}): ProjectTransferProgressPayload => {
  return {
    ...progress,
    staging: {...staging, currentRevision: staging.stagingRevision, publishedAt: publishedAt.toISOString()},
    stagingRevision: staging.stagingRevision,
  }
}

const isMissingFileError = (error: unknown) => {
  return (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && ((error as {code: unknown}).code === 'ENOENT' || (error as {code: unknown}).code === 'ENOTDIR')
  )
}

export const removeProjectTransferStaleStagingRevisions = async ({
  currentStagingRevision,
  layout,
  runtimeOptions,
}: {
  currentStagingRevision: number
  layout: ProjectTransferImportTempLayout
  runtimeOptions: RuntimePathOptions
}) => {
  const stagingRootPath = getProjectTransferStagingRootPath(layout)
  const resolvedStagingRootPath = resolveProjectTransferTempWritablePath({
    ...runtimeOptions,
    pathValue: stagingRootPath,
  })
  const entries = await readdir(resolvedStagingRootPath, {withFileTypes: true}).catch((error: unknown) => {
    return isMissingFileError(error) ? [] : Promise.reject(error)
  })

  return entries.reduce<Promise<number>>(async (promise, entry) => {
    const count = await promise
    const revision = getProjectTransferStagingRevisionFromName(entry.name)

    if (revision === null || revision === currentStagingRevision || !entry.isDirectory()) {
      return count
    }

    const revisionPath = `${stagingRootPath}/${entry.name}`
    const resolvedRevisionPath = resolveProjectTransferTempWritablePath({...runtimeOptions, pathValue: revisionPath})
    await rm(resolvedRevisionPath, {force: true, recursive: true})

    return count + 1
  }, Promise.resolve(0))
}
