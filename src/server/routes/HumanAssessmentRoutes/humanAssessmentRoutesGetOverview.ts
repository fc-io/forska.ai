import type {Context} from 'elysia'

import {
  getReviewServingHumanAssessmentCompletedCount,
  getReviewServingHumanAssessmentCompletedCounts,
} from '../../reviewServing/reviewServingHumanAssessmentCompletedCount.ts'
import {
  getActiveOrLastKnownGoodReviewServingSnapshotManifest,
  getActiveReviewServingSnapshotManifest,
  getLastKnownGoodReviewServingSnapshotManifest,
  type ReviewServingManifestRepositoryDatabase,
  type ReviewServingSnapshotManifest,
} from '../../reviewServing/reviewServingManifestRepository.ts'
import {readReviewServingRows, type ReviewServingReaderDatabase} from '../../reviewServing/reviewServingReader.ts'
import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {getCurrentReviewConfigHash} from '../../services/reviewServingProjectConfigIdentity.ts'
import {getSystemActor} from '../../utils/getSystemActor.ts'
import {getHumanAssessmentWorkloadContext} from './humanAssessmentWorkloadContext.ts'

type HumanAssessmentOverviewProjectRow = {id: string; name: string}
type HumanAssessmentOverviewCountRow = {availability?: string; count_value?: number | null; countValue?: number | null}

export const getHumanAssessmentOverviewProjectCountFromServing = async (
  projectId: string,
  contractKey: 'review.both.count' | 'review.human.count',
) => {
  const database = getAppDatabaseService() as ReviewServingManifestRepositoryDatabase & ReviewServingReaderDatabase
  const reviewConfigHash = await getCurrentReviewConfigHash(projectId)
  const manifest =
    (await getActiveReviewServingSnapshotManifest({projectId, reviewConfigHash}, database))
    ?? (await getLastKnownGoodReviewServingSnapshotManifest({projectId, reviewConfigHash}, database))

  if (!manifest) {
    return 0
  }

  const answeredCount = await getReviewServingHumanAssessmentCompletedCount({
    contractKey,
    database,
    manifest,
    projectId,
  })

  if (answeredCount !== null) {
    return answeredCount
  }

  const result = await readReviewServingRows<HumanAssessmentOverviewCountRow>(
    {
      allowStale: false,
      contractKey,
      countFilterKey: 'list:all',
      countState: {
        availability: 'ready',
        filterKey: 'list:all',
        key: 'review.list.total',
        snapshotId: manifest.snapshotId,
        value: 0,
      },
      limit: 1,
      listMode: contractKey === 'review.both.count' ? 'both' : 'human',
      namedCountKey: 'review.list.total',
      projectId,
      reviewConfigHash: manifest.reviewConfigHash,
      searchMode: 'none',
      searchState: null,
      searchTokenPrefix: null,
      snapshotId: manifest.snapshotId,
    },
    {database, diagnosticsDatabase: database, manifestDatabase: database},
  )

  const countRow = result.status === 'accepted' ? result.rows[0] : null

  return countRow?.availability === 'unavailable' ? 0 : Number(countRow?.count_value ?? countRow?.countValue ?? 0)
}

export const getHumanAssessmentOverviewProjectsFromServing = async (
  contractKey: 'review.both.count' | 'review.human.count',
) => {
  const database = getAppDatabaseService() as ReviewServingManifestRepositoryDatabase & ReviewServingReaderDatabase
  const projects = await database.queryJson<HumanAssessmentOverviewProjectRow>(
    `
    SELECT id, name
    FROM app.project
    WHERE COALESCE(archived, FALSE) = FALSE
    ORDER BY created_at DESC, id ASC
  `,
    getHumanAssessmentWorkloadContext({operation: 'overview.activeProjects'}),
  )

  const projectContexts = await Promise.all(
    projects.map(async (project) => {
      const reviewConfigHash = await getCurrentReviewConfigHash(project.id, {
        database,
        workloadContext: getHumanAssessmentWorkloadContext({operation: 'overview.reviewConfig'}),
      })
      const manifest =
        reviewConfigHash === null
          ? null
          : await getActiveOrLastKnownGoodReviewServingSnapshotManifest(
              {
                projectId: project.id,
                reviewConfigHash,
                workloadContext: getHumanAssessmentWorkloadContext({operation: 'overview.manifest'}),
              },
              database,
            )

      return {manifest, project, reviewConfigHash}
    }),
  )
  const manifestCounts = await getReviewServingHumanAssessmentCompletedCounts({
    contractKey,
    database,
    manifests: projectContexts
      .filter((context): context is typeof context & {manifest: ReviewServingSnapshotManifest} => {
        return context.manifest !== null
      })
      .map((context) => {
        return {
          projectId: context.project.id,
          reviewConfigHash: context.manifest.reviewConfigHash,
          snapshotId: context.manifest.snapshotId,
        }
      }),
  })
  const projectsWithCounts = await Promise.all(
    projectContexts.map(async ({manifest, project}) => {
      const batchedCount = manifest === null ? 0 : manifestCounts.get(project.id)
      const count =
        batchedCount
        ?? (manifest === null
          ? 0
          : await getHumanAssessmentOverviewProjectCountFromServingWithManifest(project.id, contractKey, manifest))

      return {count, projectId: project.id, projectName: project.name}
    }),
  )

  return projectsWithCounts
    .filter((project) => {
      return project.count > 0
    })
    .sort((left, right) => {
      return right.count - left.count || left.projectName.localeCompare(right.projectName)
    })
}

const getHumanAssessmentOverviewProjectCountFromServingWithManifest = async (
  projectId: string,
  contractKey: 'review.both.count' | 'review.human.count',
  manifest: ReviewServingSnapshotManifest,
) => {
  const database = getAppDatabaseService() as ReviewServingManifestRepositoryDatabase & ReviewServingReaderDatabase
  const result = await readReviewServingRows<HumanAssessmentOverviewCountRow>(
    {
      allowStale: false,
      contractKey,
      countFilterKey: 'list:all',
      countState: {
        availability: 'ready',
        filterKey: 'list:all',
        key: 'review.list.total',
        snapshotId: manifest.snapshotId,
        value: 0,
      },
      limit: 1,
      listMode: contractKey === 'review.both.count' ? 'both' : 'human',
      namedCountKey: 'review.list.total',
      projectId,
      reviewConfigHash: manifest.reviewConfigHash,
      searchMode: 'none',
      searchState: null,
      searchTokenPrefix: null,
      snapshotId: manifest.snapshotId,
    },
    {database, diagnosticsDatabase: database, manifestDatabase: database},
  )

  const countRow = result.status === 'accepted' ? result.rows[0] : null

  return countRow?.availability === 'unavailable' ? 0 : Number(countRow?.count_value ?? countRow?.countValue ?? 0)
}

export const humanAssessmentRoutesGetOverview = async ({
  request: _request,
}: {
  request: Request
  set: Context['set']
}) => {
  const perProject = await getHumanAssessmentOverviewProjectsFromServing('review.human.count')

  const systemActor = getSystemActor()
  const totalCompleted = perProject.reduce((sum, row) => {
    return sum + Number(row.count ?? 0)
  }, 0)
  const perUser = [
    {userId: systemActor.id, userName: systemActor.name, email: systemActor.email, count: totalCompleted},
  ]

  return {data: {projects: perProject, users: perUser}}
}
