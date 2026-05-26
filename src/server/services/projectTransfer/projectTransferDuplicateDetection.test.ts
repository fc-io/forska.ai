import {expect, test} from 'bun:test'

import {getProjectTransferDuplicateImportDetection} from './projectTransferDuplicateDetection.ts'

test('duplicate import detection warns from completed import history by package fingerprint only', async () => {
  const statements: string[] = []
  const runner = {
    queryJson: async <T>(statement: string): Promise<T[]> => {
      statements.push(statement)

      return [
        {
          commitId: 'commit-duplicate',
          completionPayloadJson: {projectId: 'target-project', projectName: 'Target Project', status: 'completed'},
          createdAt: new Date('2026-05-26T10:00:00.000Z'),
          direction: 'import',
          id: 'history-duplicate',
          packageFingerprint: 'fingerprint-duplicate',
          payloadCountsJson: {articles: 1},
          schemaVersion: 1,
          sessionId: 'session-duplicate',
          sourceProjectId: 'source-project',
          sourceProjectName: 'Source Project',
          targetProjectId: 'target-project',
          targetProjectName: 'Target Project',
        },
      ] as T[]
    },
  }

  const result = await getProjectTransferDuplicateImportDetection({packageFingerprint: 'fingerprint-duplicate', runner})

  expect(result.matches).toEqual([
    {
      createdAt: new Date('2026-05-26T10:00:00.000Z'),
      historyId: 'history-duplicate',
      sessionId: 'session-duplicate',
      targetProjectId: 'target-project',
      targetProjectName: 'Target Project',
    },
  ])
  expect(result.warnings).toMatchObject([
    {action: 'warned', code: 'duplicateImportMatch', scope: 'manifest.packageFingerprint', severity: 'warning'},
  ])
  expect(statements[0]).toContain('WHERE direction =')
  expect(statements[0]).toContain('package_fingerprint')
})

test('duplicate import detection does not warn without a package fingerprint', async () => {
  const runner = {
    queryJson: async <T>(_statement: string): Promise<T[]> => {
      throw new Error('Duplicate detection should not query without a fingerprint')
    },
  }

  const result = await getProjectTransferDuplicateImportDetection({packageFingerprint: null, runner})

  expect(result.matches).toEqual([])
  expect(result.warnings).toEqual([])
})
