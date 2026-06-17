import {expect, test} from 'bun:test'

import {type ReviewServingDirtyWorkClaim} from './reviewServingDirtyWorkService.ts'
import {
  projectReviewServingJudgmentPayloadRows,
  type ReviewServingJudgmentPayloadProjectorDatabase,
} from './reviewServingJudgmentPayloadProjector.ts'
import {getReviewServingReadContract} from './reviewServingReadContracts.ts'
import {buildReviewServingRowsSql} from './reviewServingSql.ts'

const judgmentClaim = (input?: Partial<ReviewServingDirtyWorkClaim>): ReviewServingDirtyWorkClaim => {
  return {
    articleId: 'article-1',
    dirtyKind: 'judgment.llm.updated',
    dirtyRangeEnd: null,
    dirtyRangeStart: null,
    dirtyWorkId: 'dirty-work-1',
    firstSourceHighWaterMark: 4,
    latestDeltaId: 'delta-1',
    latestSourceHighWaterMark: 6,
    projectId: 'project-1',
    projectionComponent: 'payload',
    projectionIdentity: 'payload:identity-1',
    scopeId: 'project-1:article-1',
    scopeKind: 'article',
    sourcePartition: 'review-change:judgment',
    status: 'running',
    ...input,
  }
}

const createJudgmentPayloadDatabase = (input?: {
  humanRows?: readonly Record<string, unknown>[]
  llmRows?: readonly Record<string, unknown>[]
}) => {
  const statements: string[] = []
  const database: ReviewServingJudgmentPayloadProjectorDatabase = {
    queryJson: async <T>(statement: string) => {
      statements.push(statement)

      if (statement.includes('latest_judgment AS')) {
        return (input?.llmRows ?? []) as T[]
      }

      return (input?.humanRows ?? []) as T[]
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

const projectInput = (claims: readonly ReviewServingDirtyWorkClaim[] = []) => {
  return {
    claims,
    listModeKeys: ['llm', 'human', 'both'] as const,
    modelId: 'model-1',
    projectId: 'project-1',
    reviewConfigHash: 'review-config-1',
    snapshotId: 'snapshot-1',
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
  }
}

test('judgment payload projection separates llm and human payload kinds across overlapping prompts', async () => {
  const {database, statements} = createJudgmentPayloadDatabase({
    humanRows: [
      {
        answer: 'include',
        articleId: 'article-1',
        comment: 'human note',
        humanJudgmentCreatedAt: '2026-01-01T00:00:00.000Z',
        humanJudgmentId: 'human-1',
        humanJudgmentUpdatedAt: '2026-01-03T00:00:00.000Z',
        isAnswered: true,
        payloadReferenceKind: 'human_prompt',
        promptId: 'prompt-1',
        promptOrder: 1,
      },
      {
        answer: 'maybe',
        articleId: 'article-1',
        comment: null,
        humanJudgmentCreatedAt: '2026-01-02T00:00:00.000Z',
        humanJudgmentId: 'human-summary-1',
        humanJudgmentUpdatedAt: '2026-01-04T00:00:00.000Z',
        isAnswered: true,
        payloadReferenceKind: 'human_summary',
        promptId: 'summary',
        promptOrder: -1,
      },
    ],
    llmRows: [
      {
        answeredOriginal: 'include',
        answeredOriginalAsArray: ['include', 'maybe'],
        articleId: 'article-1',
        assessmentComment: 'correct',
        assessmentCreatedAt: '2026-01-05T00:00:00.000Z',
        assessmentId: 'assessment-1',
        assessmentIsCorrect: true,
        assessmentUpdatedAt: '2026-01-06T00:00:00.000Z',
        chunkingStrategy: 'none',
        confidenceOriginal: 80,
        explanation: 'llm explanation',
        isAnswered: true,
        judgmentCreatedAt: '2026-01-01T00:00:00.000Z',
        judgmentId: 'judgment-1',
        judgmentUpdatedAt: '2026-01-02T00:00:00.000Z',
        modelId: 'model-1',
        placeholderKind: null,
        promptId: 'prompt-1',
        promptOrder: 1,
        quotes: ['quote one'],
        snapshotProjectId: 'project-1',
        snapshotProjectModelName: 'model name',
      },
      {
        answeredOriginal: null,
        answeredOriginalAsArray: null,
        articleId: 'article-1',
        assessmentComment: null,
        assessmentCreatedAt: null,
        assessmentId: null,
        assessmentIsCorrect: null,
        assessmentUpdatedAt: null,
        chunkingStrategy: null,
        confidenceOriginal: null,
        explanation: null,
        isAnswered: null,
        judgmentCreatedAt: null,
        judgmentId: null,
        judgmentUpdatedAt: null,
        modelId: null,
        placeholderKind: 'llm.unanswered',
        promptId: 'prompt-2',
        promptOrder: 2,
        quotes: null,
        snapshotProjectId: null,
        snapshotProjectModelName: null,
      },
    ],
  })

  const result = await projectReviewServingJudgmentPayloadRows(projectInput([judgmentClaim()]), database)
  const joined = statements.join('\n')
  const inserts = statements.filter((statement) => {
    return statement.includes('INSERT INTO mart.review_article_judgment_detail_serving_v4')
  })

  expect(result).toEqual({humanRowCount: 4, llmRowCount: 4})
  expect(inserts).toHaveLength(8)
  expect(joined).toContain("'llm'")
  expect(joined).toContain("'human'")
  expect(joined).toContain("'both'")
  expect(joined).toContain("'summary'")
  expect(joined).toContain("'llm.unanswered'")
  expect(joined).toContain('llm explanation')
  expect(joined).toContain('quote one')
  expect(joined).toContain('assessment-1')
  expect(joined).toContain('payloadReference')
  expect(joined).toContain('human_summary')
  expect(joined).toContain('2026-01-02T00:00:00.000Z')
  expect(joined).toContain('2026-01-04T00:00:00.000Z')
})

test('judgment payload projection replaces only dirty article detail rows', async () => {
  const {database, statements} = createJudgmentPayloadDatabase({
    humanRows: [],
    llmRows: [
      {
        answeredOriginal: null,
        answeredOriginalAsArray: null,
        articleId: 'article-1',
        assessmentComment: null,
        assessmentCreatedAt: null,
        assessmentId: null,
        assessmentIsCorrect: null,
        assessmentUpdatedAt: null,
        chunkingStrategy: null,
        confidenceOriginal: null,
        explanation: null,
        isAnswered: null,
        judgmentCreatedAt: null,
        judgmentId: null,
        judgmentUpdatedAt: null,
        modelId: null,
        placeholderKind: 'llm.unanswered',
        promptId: 'prompt-1',
        promptOrder: 1,
        quotes: null,
        snapshotProjectId: null,
        snapshotProjectModelName: null,
      },
    ],
  })

  await projectReviewServingJudgmentPayloadRows(projectInput([judgmentClaim()]), database)
  const llmSelect = statements.find((statement) => {
    return statement.includes('latest_judgment AS')
  })
  const deleteStatements = statements.filter((statement) => {
    return statement.includes('DELETE FROM mart.review_article_judgment_detail_serving_v4')
  })
  const llmDeleteStatement = deleteStatements.find((statement) => {
    return statement.includes("payload_kind IS NOT DISTINCT FROM 'llm'")
  })
  const humanDeleteStatement = deleteStatements.find((statement) => {
    return statement.includes("payload_kind IS NOT DISTINCT FROM 'human'")
  })

  expect(llmSelect).toContain("VALUES ('article-1')")
  expect(llmSelect).toContain('INNER JOIN article_id_filter dirty ON dirty.article_id = scope.article_id')
  expect(llmDeleteStatement).toContain("article_id IN ('article-1')")
  expect(llmDeleteStatement).toContain("list_mode_key IS NOT DISTINCT FROM 'llm'")
  expect(humanDeleteStatement).toContain("article_id IN ('article-1')")
  expect(humanDeleteStatement).toContain("list_mode_key IS NOT DISTINCT FROM 'human'")
  expect(statements.join('\n')).toContain('INSERT INTO app.review_serving_dirty_work_ack')
})

test('article-set judgment hydration reads bounded payload rows with stable ordering', () => {
  const contract = getReviewServingReadContract('review.both.list.humanJudgments')
  const sql = buildReviewServingRowsSql({
    articleIdsParameter: '$articleIds',
    contract,
    displayIdentityParameter: '$displayIdentity',
    limitParameter: '$limit',
    listModeParameter: '$listMode',
    payloadIdentityParameter: '$payloadIdentity',
    projectIdParameter: '$projectId',
    projectScopeIdentityParameter: '$projectScopeIdentity',
    reviewConfigHashParameter: '$reviewConfigHash',
    searchIdentityParameter: '$searchIdentity',
    snapshotIdParameter: '$snapshotId',
  })

  expect(sql).toContain('FROM mart.review_article_judgment_detail_serving_v4')
  expect(sql).toContain('AND article_id IN (SELECT unnest($articleIds))')
  expect(sql).toContain("AND list_mode_key = 'both'")
  expect(sql).toContain("AND payload_kind = 'human'")
  expect(sql).toContain('ORDER BY article_id ASC, prompt_order ASC NULLS LAST, prompt_id ASC')
  expect(sql).toContain('LIMIT $limit')
})
