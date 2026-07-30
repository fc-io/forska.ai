import {expect, test} from 'bun:test'

import {getReviewServingPhysicalShapeDiagnostics} from './reviewServingPhysicalShapeDiagnostics.ts'

test('review-serving physical shape diagnostics collect bounded project-scoped hot table metrics', async () => {
  const statements: string[] = []
  const existingTables = new Set([
    'mart.review_article_filter_posting_serving_v4',
    'mart.review_article_judgment_detail_serving_v4',
    'mart.review_selected_article_import_staging_v4',
    'mart.review_selected_article_import_current_v4',
    'mart.review_article_summary_rebuild_accumulator_v4',
    'mart.review_unassessed_queue_serving_v4',
  ])
  const existingColumns = new Set([
    'mart.review_article_filter_posting_serving_v4.article_ids',
    'mart.review_unassessed_queue_serving_v4.prompt_ids',
  ])
  const database = {
    queryJson: async <T>(statement: string): Promise<T[]> => {
      statements.push(statement)

      if (statement.includes('FROM information_schema.tables')) {
        const schemaName = statement.includes("table_schema = 'mart'") ? 'mart' : 'app'
        const tableName = statement.match(/table_name = '([^']+)'/)?.[1] ?? ''
        return [{tableCount: existingTables.has(`${schemaName}.${tableName}`) ? 1 : 0}] as T[]
      }

      if (statement.includes('FROM information_schema.columns')) {
        const schemaName = statement.includes("table_schema = 'mart'") ? 'mart' : 'app'
        const tableName = statement.match(/table_name = '([^']+)'/)?.[1] ?? ''
        const columnName = statement.match(/column_name = '([^']+)'/)?.[1] ?? ''
        return [{columnCount: existingColumns.has(`${schemaName}.${tableName}.${columnName}`) ? 1 : 0}] as T[]
      }

      if (statement.includes('FROM mart.review_article_filter_posting_serving_v4')) {
        return [
          {
            approxStringBytes: '120',
            avgArrayLength: 2.5,
            currentProjectRows: '2',
            maxArrayLength: '4',
            rowCount: '5',
            totalArrayMemberships: '5',
          },
        ] as T[]
      }

      if (statement.includes('FROM mart.review_unassessed_queue_serving_v4')) {
        return [
          {
            approxStringBytes: '72',
            avgArrayLength: 3,
            currentProjectRows: '1',
            maxArrayLength: '3',
            rowCount: '2',
            totalArrayMemberships: '3',
          },
        ] as T[]
      }

      if (statement.includes('FROM mart.review_article_judgment_detail_serving_v4')) {
        return [
          {
            answeredArrayApproxStringBytes: '30',
            answeredArrayMemberships: '3',
            answeredOriginalApproxStringBytes: '21',
            answeredOriginalNonNullRows: '2',
            currentProjectRows: '4',
            humanCommentApproxStringBytes: '13',
            humanCommentNonNullRows: '1',
            rowCount: '8',
          },
        ] as T[]
      }

      if (statement.includes('FROM mart.review_selected_article_import_current_v4')) {
        return [{currentProjectRows: '9', rowCount: '12', tombstoneRows: '1'}] as T[]
      }

      if (statement.includes('FROM mart.review_selected_article_import_staging_v4')) {
        return [
          {currentProjectRows: '7', publishedRows: '3', rowCount: '11', tombstoneRows: '2', unpublishedRows: '4'},
        ] as T[]
      }

      if (statement.includes('FROM mart.review_article_summary_rebuild_accumulator_v4')) {
        return [{approxStringBytes: '345', currentProjectRows: '6', rowCount: '10'}] as T[]
      }

      throw new Error(`Unexpected query: ${statement}`)
    },
  }

  const diagnostics = await getReviewServingPhysicalShapeDiagnostics("project-'shape", database)

  expect(diagnostics.projectId).toBe("project-'shape")
  expect(diagnostics.postingArticleIds).toMatchObject({
    approxStringBytes: 120,
    columnExists: true,
    currentProjectRows: 2,
    exists: true,
    maxArrayLength: 4,
    rowCount: 5,
    totalArrayMemberships: 5,
  })
  expect(diagnostics.queuePromptIds).toMatchObject({
    approxStringBytes: 72,
    columnExists: true,
    currentProjectRows: 1,
    exists: true,
    rowCount: 2,
    table: 'mart.review_unassessed_queue_serving_v4',
    totalArrayMemberships: 3,
  })
  expect(diagnostics.judgmentDetailAnswerCommentFields).toMatchObject({
    answeredArrayMemberships: 3,
    answeredOriginalApproxStringBytes: 21,
    answeredOriginalNonNullRows: 2,
    humanCommentApproxStringBytes: 13,
    humanCommentNonNullRows: 1,
  })
  expect(diagnostics.selectedImport.current).toMatchObject({currentProjectRows: 9, exists: true, tombstoneRows: 1})
  expect(diagnostics.selectedImport.staging).toMatchObject({
    currentProjectRows: 7,
    exists: true,
    publishedRows: 3,
    rowCount: 11,
    table: 'mart.review_selected_article_import_staging_v4',
    unpublishedRows: 4,
  })
  expect(diagnostics.summaryAccumulator).toMatchObject({approxStringBytes: 345, currentProjectRows: 6, exists: true})
  expect(statements.join('\n')).toContain("project_id = 'project-''shape'")
  expect(statements.join('\n')).toContain('array_length(article_ids)')
  expect(statements.join('\n')).toContain('array_length(prompt_ids)')
  expect(statements.join('\n')).toContain('answered_original')
  expect(statements.join('\n')).toContain('human_comment')
  expect(statements.join('\n')).toContain('published_at')
  expect(statements.join('\n')).toContain('source_chunk_ids_key')
})

test('review-serving physical shape diagnostics tolerate missing optional array columns', async () => {
  const database = {
    queryJson: async <T>(statement: string): Promise<T[]> => {
      if (statement.includes('FROM information_schema.tables')) {
        return [{tableCount: 1}] as T[]
      }

      if (statement.includes('FROM information_schema.columns')) {
        return [{columnCount: 0}] as T[]
      }

      if (
        statement.includes('FROM mart.review_article_filter_posting_serving_v4')
        || statement.includes('FROM mart.review_unassessed_queue_serving_v4')
      ) {
        expect(statement).not.toContain('array_length(')
        return [{currentProjectRows: '3', rowCount: '5'}] as T[]
      }

      return [{currentProjectRows: '0', rowCount: '0', tombstoneRows: '0'}] as T[]
    },
  }

  const diagnostics = await getReviewServingPhysicalShapeDiagnostics('project-with-old-shape', database)

  expect(diagnostics.postingArticleIds).toMatchObject({
    columnExists: false,
    currentProjectRows: 3,
    exists: true,
    rowCount: 5,
    totalArrayMemberships: null,
  })
  expect(diagnostics.queuePromptIds).toMatchObject({
    columnExists: false,
    currentProjectRows: 3,
    exists: true,
    rowCount: 5,
    totalArrayMemberships: null,
  })
})
