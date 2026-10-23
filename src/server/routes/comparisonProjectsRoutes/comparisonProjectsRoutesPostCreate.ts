import {Elysia, t} from 'elysia'

import {rejectLegacyFullTextNoImagesBody} from '../../utils/rejectLegacyFullTextNoImagesBody.ts'
import {checkpointComparisonProjectMutation} from './comparisonProjectMutationCheckpoint.ts'
import {appDatabaseService} from './comparisonProjectRouteServices.ts'
import {markComparisonProjectServingStaleAndQueueRebuild} from './comparisonProjectServingRebuildQueue.ts'
import {
  assertComparisonProjectSourceProjectIdsShareFullTextStrategy,
  getComparisonProjectBodySourceProjectIds,
} from './comparisonProjectSourceFullTextStrategy.ts'
import {createComparisonProjectRecord} from './createComparisonProjectRecord.ts'

export const comparisonProjectsRoutesPostCreate = new Elysia().post(
  '/api/comparison-projects',
  async (context) => {
    const {body} = context
    await assertComparisonProjectSourceProjectIdsShareFullTextStrategy(
      appDatabaseService,
      getComparisonProjectBodySourceProjectIds(body),
    )
    const createdComparisonProject = await appDatabaseService.transaction(async (tx) => {
      return createComparisonProjectRecord(tx, body)
    })
    await checkpointComparisonProjectMutation()
    await markComparisonProjectServingStaleAndQueueRebuild(createdComparisonProject.id)

    return {data: createdComparisonProject}
  },
  {
    transform: rejectLegacyFullTextNoImagesBody,
    body: t.Object({
      name: t.String(),
      description: t.Optional(t.Union([t.String(), t.Null()])),
      modelIds: t.Optional(t.Array(t.String())),
      compareWithHumans: t.Optional(t.Boolean()),
      allowConflictResolution: t.Optional(t.Boolean()),
      humanJudgmentMode: t.Optional(t.Union([t.Literal('prompt'), t.Literal('summary')])),
      summarySourceProjectId: t.Optional(t.Union([t.String(), t.Null()])),
      useTitle: t.Boolean(),
      useAbstract: t.Boolean(),
      useFulltext: t.Boolean(),
      importRoutes: t.Optional(t.Array(t.String())),
      sourceProjectIds: t.Optional(t.Array(t.String())),
      promptSelections: t.Optional(t.Array(t.Object({promptId: t.String(), order: t.Number()}))),
    }),
  },
)
