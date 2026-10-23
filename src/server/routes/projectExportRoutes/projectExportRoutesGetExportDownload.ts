import type {Context} from 'elysia'

import {isReviewServingSnapshotDetailReady} from '../../reviewServing/reviewBulkOperationService.ts'
import {
  getActiveReviewServingSnapshotManifest,
  getReviewServingSnapshotManifest,
} from '../../reviewServing/reviewServingManifestRepository.ts'
import {getJsonValue} from '../../services/appQueryHelpers.ts'
import {getCsvDownloadHeaders} from '../../utils/csvResponse.ts'
import {assertProjectIsActive} from '../projectsRoutes/projectAccessGuard.ts'
import {exportBatchSize} from './exportBatchSize.ts'
import {getExportJob} from './getExportJob.ts'
import {getProject} from './getProject.ts'
import {buildExportCsvStream} from './projectExportRoutesGetExportDownload/buildExportCsvStream.ts'
import {getStringArray} from './projectExportRoutesGetExportDownload/getStringArray.ts'
import type {
  ExportContract,
  ExportServingSnapshotScope,
} from './projectExportRoutesGetExportDownload/projectExportDownloadTypes.ts'
import type {ExportJobRow} from './projectExportRouteTypes.ts'

const getExportContract = (criteriaJson: unknown): ExportContract => {
  const criteria = getJsonValue(criteriaJson)

  return criteria && typeof criteria === 'object' && !Array.isArray(criteria) && 'exportContract' in criteria
    ? ((criteria as {exportContract?: ExportContract}).exportContract ?? {})
    : {}
}

const getExportSourceProjectIds = (criteriaJson: unknown) => {
  const criteria = getJsonValue(criteriaJson)

  return criteria && typeof criteria === 'object' && !Array.isArray(criteria)
    ? getStringArray((criteria as {sourceProjectIds?: unknown}).sourceProjectIds)
    : []
}

const getExportArticleIds = (resultManifestJson: unknown) => {
  const manifest = getJsonValue(resultManifestJson)

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || !('batches' in manifest)) {
    return []
  }

  const batches = (manifest as {batches?: unknown}).batches

  return batches && typeof batches === 'object' && !Array.isArray(batches)
    ? Object.values(batches).flatMap(getStringArray)
    : []
}

const getExportArticleIdBatches = (resultManifestJson: unknown) => {
  const manifest = getJsonValue(resultManifestJson)

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || !('batches' in manifest)) {
    return []
  }

  const batches = (manifest as {batches?: unknown}).batches

  return batches && typeof batches === 'object' && !Array.isArray(batches)
    ? Object.values(batches).flatMap((batch) => {
        const articleIds = getStringArray(batch)

        return Array.from({length: Math.ceil(articleIds.length / exportBatchSize)}, (_, index) => {
          return articleIds.slice(index * exportBatchSize, (index + 1) * exportBatchSize)
        })
      })
    : []
}

const getExportReviewConfigHashBySourceProjectId = (criteriaJson: unknown) => {
  const criteria = getJsonValue(criteriaJson)
  const hashes =
    criteria && typeof criteria === 'object' && !Array.isArray(criteria)
      ? (criteria as {sourceProjectReviewConfigHashes?: unknown}).sourceProjectReviewConfigHashes
      : null

  return hashes && typeof hashes === 'object' && !Array.isArray(hashes) ? (hashes as Record<string, string | null>) : {}
}

const getExportServingSnapshotScopes = async (input: {job: ExportJobRow; sourceProjectIds: string[]}) => {
  const reviewConfigHashByProjectId = getExportReviewConfigHashBySourceProjectId(input.job.criteriaJson)
  const scopes = await Promise.all(
    input.sourceProjectIds.map(async (projectId) => {
      const reviewConfigHash = reviewConfigHashByProjectId[projectId] ?? input.job.reviewConfigHash
      const manifest = input.job.latestSnapshotSemantics
        ? await getActiveReviewServingSnapshotManifest({componentStateMode: 'available', projectId, reviewConfigHash})
        : input.job.snapshotId
          ? await getReviewServingSnapshotManifest({
              componentStateMode: 'available',
              projectId,
              snapshotId: input.job.snapshotId,
            })
          : null

      return manifest
        && (input.job.latestSnapshotSemantics ? manifest.status === 'active' : true)
        && isReviewServingSnapshotDetailReady(manifest)
        ? {projectId, reviewConfigHash: manifest.reviewConfigHash ?? reviewConfigHash, snapshotId: manifest.snapshotId}
        : null
    }),
  )

  return scopes.filter((scope): scope is ExportServingSnapshotScope => {
    return scope !== null
  })
}

export const projectExportRoutesGetExportDownload = async ({
  params,
  set,
}: {
  params: {id: string; jobId: string}
  set: Context['set']
}) => {
  await assertProjectIsActive(params.id)

  const [project, job] = await Promise.all([getProject(params.id), getExportJob(params.id, params.jobId)])

  if (!project || !job) {
    set.status = 404
    return {error: 'Export job not found', success: false}
  }

  if (job.status !== 'completed') {
    set.status = 409
    return {error: 'Export job is not completed yet', status: job.status, success: false}
  }

  const articleIds = getExportArticleIds(job.resultManifestJson)
  const articleIdBatches = getExportArticleIdBatches(job.resultManifestJson)
  const sourceProjectIds = getExportSourceProjectIds(job.criteriaJson)
  const requestedSourceProjectIds = sourceProjectIds.length > 0 ? sourceProjectIds : [params.id]
  const snapshotScopes = await getExportServingSnapshotScopes({job, sourceProjectIds: requestedSourceProjectIds})

  if (articleIds.length > 0 && snapshotScopes.length !== requestedSourceProjectIds.length) {
    set.status = 409
    return {error: 'Export serving snapshot is unavailable', success: false}
  }

  const csv = buildExportCsvStream({
    articleIdBatches,
    contract: getExportContract(job.criteriaJson),
    projectId: params.id,
    snapshotScopes,
  })
  const filename = `${project.name.replace(/[^a-zA-Z0-9]/g, '_')}_export_${new Date().toISOString().slice(0, 10)}.csv`
  const headers = getCsvDownloadHeaders(filename)

  set.headers['Content-Type'] = headers['Content-Type']
  set.headers['Content-Disposition'] = headers['Content-Disposition']

  return new Response(csv, {headers})
}
