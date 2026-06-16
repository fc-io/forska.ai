import {readdirSync, readFileSync} from 'node:fs'
import {join, relative} from 'node:path'

import {expect, test} from 'bun:test'

import {type ReviewServingProjectorWriterDatabase} from './reviewServingProjectorWriter.ts'
import {
  getReviewServingProjectorReplayKey,
  writeReviewServingProjectorComponent,
} from './reviewServingProjectorWriter.ts'

const workspaceRoot = join(import.meta.dir, '../../..')

const getTypeScriptFiles = (directory: string): readonly string[] => {
  return readdirSync(directory, {withFileTypes: true}).flatMap((entry) => {
    const path = join(directory, entry.name)

    return entry.isDirectory() ? getTypeScriptFiles(path) : path.endsWith('.ts') ? [path] : []
  })
}

const createWriterDatabase = () => {
  const statements: string[] = []
  const database: ReviewServingProjectorWriterDatabase = {
    queryJson: async <T>(statement: string) => {
      statements.push(statement)

      if (statement.includes('FROM app.review_selected_import_snapshot')) {
        return [{status: 'completed'}] as T[]
      }

      if (statement.includes('FROM app.review_projection_identity_manifest')) {
        return [
          {
            baseGeneration: 1,
            definitionVersion: 'display-v1',
            inputDigest: null,
            inputWatermark: 8,
            invalidationReason: null,
            manifestId: 'display-manifest-1',
            patchRangeEnd: null,
            patchRangeStart: null,
            patchWatermark: 2,
            projectId: 'project-1',
            projectionComponent: 'display',
            projectionIdentity: 'display:identity-1',
            promptConfigHash: null,
            reviewConfigHash: 'review-config-1',
            status: 'candidate',
          },
        ] as T[]
      }

      if (statement.includes('FROM app.review_serving_snapshot_manifest') && statement.includes('snapshot_id =')) {
        return [
          {
            componentStateJson: JSON.stringify({
              optional: [],
              required: [
                {
                  baseGeneration: '1',
                  component: 'display',
                  patchWatermark: '2',
                  projectionIdentity: 'display:identity-1',
                  requirement: 'required',
                },
              ],
            }),
            composedIdentityJson: JSON.stringify({route: 'review.llm.rows', version: 1}),
            lastError: null,
            lastKnownGoodSnapshotId: null,
            optionalComponentsJson: JSON.stringify([]),
            projectId: 'project-1',
            requiredComponentsJson: JSON.stringify(['display']),
            reviewConfigHash: 'review-config-1',
            selectedImportSnapshotId: 'selected-import-1',
            snapshotId: 'snapshot-1',
            snapshotStatus: 'candidate',
            sourceWatermarksJson: JSON.stringify({reviewChange: 8}),
            validationResultJson: null,
          },
        ] as T[]
      }

      return [] as T[]
    },
    run: async (statement: string) => {
      statements.push(statement)
    },
    transaction: async (operation) => {
      return operation(database)
    },
  }

  return {database, statements}
}

test('projector replay keys include snapshot, generation, watermark, identity, and row scope', () => {
  const first = getReviewServingProjectorReplayKey({
    articleId: 'article-1',
    baseGeneration: 4,
    contributionKey: 'summary:review.list.total',
    filterKey: 'publicationYear:2026',
    patchWatermark: 9,
    projectionIdentity: 'summary:identity-1',
    promptId: 'prompt-1',
    snapshotId: 'snapshot-1',
  })
  const replay = getReviewServingProjectorReplayKey({
    articleId: 'article-1',
    baseGeneration: 4,
    contributionKey: 'summary:review.list.total',
    filterKey: 'publicationYear:2026',
    patchWatermark: 9,
    projectionIdentity: 'summary:identity-1',
    promptId: 'prompt-1',
    snapshotId: 'snapshot-1',
  })
  const nextPatch = getReviewServingProjectorReplayKey({
    articleId: 'article-1',
    baseGeneration: 4,
    contributionKey: 'summary:review.list.total',
    filterKey: 'publicationYear:2026',
    patchWatermark: 10,
    projectionIdentity: 'summary:identity-1',
    promptId: 'prompt-1',
    snapshotId: 'snapshot-1',
  })

  expect(first).toBe(replay)
  expect(first).not.toBe(nextPatch)
})

test('projector writer updates rows, manifests, acknowledgements, watermarks, and promotion in one transaction', async () => {
  const {database, statements} = createWriterDatabase()

  await writeReviewServingProjectorComponent(
    {
      acknowledgements: [
        {
          articleId: 'article-1',
          dirtyKind: 'article.display.updated',
          dirtyRangeEnd: null,
          dirtyRangeStart: null,
          dirtyWorkId: 'dirty-work-1',
          firstSourceHighWaterMark: 7,
          latestDeltaId: 'delta-1',
          latestSourceHighWaterMark: 8,
          projectId: 'project-1',
          projectionComponent: 'display',
          projectionIdentity: 'display:identity-1',
          scopeId: 'project-1:article-1',
          scopeKind: 'article',
          sourcePartition: 'review-change',
          status: 'running',
        },
      ],
      component: 'display',
      projectionManifests: [
        {
          baseGeneration: 1,
          definitionVersion: 'display-v1',
          inputWatermark: 8,
          patchWatermark: 2,
          projectId: 'project-1',
          projectionComponent: 'display',
          projectionIdentity: 'display:identity-1',
          status: 'candidate',
        },
      ],
      records: [
        {
          keyColumns: ['project_id', 'review_config_hash', 'snapshot_id', 'list_mode_key', 'article_id'],
          table: 'mart.review_article_serving_v4',
          values: {
            article_id: 'article-1',
            article_title: 'Title',
            base_generation: 1,
            display_identity: 'display:identity-1',
            list_mode_key: 'llm',
            patch_watermark: 2,
            project_id: 'project-1',
            project_scope_identity: 'scope:identity-1',
            review_config_hash: 'review-config-1',
            snapshot_id: 'snapshot-1',
          },
        },
      ],
      candidateSnapshot: {
        componentRequirements: {optionalComponents: [], requiredComponents: ['display']},
        componentState: {
          optional: [],
          required: [
            {
              baseGeneration: '1',
              component: 'display',
              patchWatermark: '2',
              projectionIdentity: 'display:identity-1',
              requirement: 'required',
            },
          ],
        },
        composedIdentity: {route: 'review.llm.rows', version: 1},
        projectId: 'project-1',
        reviewConfigHash: 'review-config-1',
        selectedImportSnapshotId: 'selected-import-1',
        snapshotId: 'snapshot-1',
        sourceWatermarks: {reviewChange: 8},
      },
      snapshotPromotion: {projectId: 'project-1', reviewConfigHash: 'review-config-1', snapshotId: 'snapshot-1'},
      watermark: {
        projectId: 'project-1',
        projectionComponent: 'display',
        projectorName: 'display-projector',
        sourceHighWaterMark: 8,
        sourcePartition: 'review-change',
      },
    },
    database,
  )

  expect(
    statements.some((statement) => {
      return statement.includes('FROM app.review_source_change_outbox')
    }),
  ).toBe(true)
  expect(
    statements.some((statement) => {
      return statement.includes('INSERT INTO app.review_projection_identity_manifest')
    }),
  ).toBe(true)
  expect(
    statements.some((statement) => {
      return statement.includes('INSERT INTO mart.review_article_serving_v4')
    }),
  ).toBe(true)
  expect(
    statements.some((statement) => {
      return statement.includes('INSERT INTO app.review_serving_dirty_work_ack')
    }),
  ).toBe(true)
  expect(
    statements.some((statement) => {
      return statement.includes('INSERT INTO app.review_serving_projector_watermark')
    }),
  ).toBe(true)
  expect(
    statements.some((statement) => {
      return statement.includes("snapshot_status = 'active'")
    }),
  ).toBe(true)
})

test('only the projector writer boundary writes V4 mart rows and promotes active snapshots', () => {
  const offenders = getTypeScriptFiles(join(workspaceRoot, 'src/server'))
    .filter((filePath) => {
      const repoPath = relative(workspaceRoot, filePath)

      return repoPath !== 'src/server/reviewServing/reviewServingProjectorWriter.ts' && !repoPath.endsWith('.test.ts')
    })
    .flatMap((filePath) => {
      const source = readFileSync(filePath, 'utf8')
      const markers = [
        'INSERT INTO mart.review_.*_v4',
        'UPDATE mart.review_.*_v4',
        'DELETE FROM mart.review_.*_v4',
        "SET[\\s\\S]{0,200}snapshot_status = 'active'",
      ]

      return markers
        .filter((marker) => {
          return new RegExp(marker, 'u').test(source)
        })
        .map((marker) => {
          return `${relative(workspaceRoot, filePath)}: ${marker}`
        })
    })

  expect(offenders).toEqual([])
})
