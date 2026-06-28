import type {Context} from 'elysia'

import {
  getActiveReviewServingSnapshotManifest,
  getLastKnownGoodReviewServingSnapshotManifest,
  type ReviewServingManifestRepositoryDatabase,
} from '../../reviewServing/reviewServingManifestRepository.ts'
import {readReviewServingRows, type ReviewServingReaderDatabase} from '../../reviewServing/reviewServingReader.ts'
import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {getCurrentReviewConfigHash} from '../../services/reviewServingProjectConfigIdentity.ts'
import {getSystemActor} from '../../utils/getSystemActor.ts'

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
  const projects = await getAppDatabaseService().queryJson<HumanAssessmentOverviewProjectRow>(`
    SELECT id, name
    FROM app.project
    WHERE COALESCE(archived, FALSE) = FALSE
    ORDER BY created_at DESC, id ASC
  `)

  const projectsWithCounts = await Promise.all(
    projects.map(async (project) => {
      const count = await getHumanAssessmentOverviewProjectCountFromServing(project.id, contractKey)

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
