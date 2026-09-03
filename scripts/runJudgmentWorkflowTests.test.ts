import {existsSync} from 'node:fs'
import {resolve} from 'node:path'

import {expect, test} from 'bun:test'

import {
  judgmentWorkflowComponentLifecycleTestFiles,
  judgmentWorkflowFocusedTestFiles,
  judgmentWorkflowRecoveryTestFiles,
} from './judgmentWorkflowTestFiles.ts'
import {getJudgmentWorkflowTestCommand, getJudgmentWorkflowTestCommands} from './runJudgmentWorkflowTests.ts'

const allGateFiles = [
  ...judgmentWorkflowFocusedTestFiles,
  ...judgmentWorkflowComponentLifecycleTestFiles,
  ...judgmentWorkflowRecoveryTestFiles,
]

test('judgment workflow gates reference existing adjacent Bun test files', () => {
  expect(
    allGateFiles.filter((filePath) => {
      return !existsSync(filePath)
    }),
  ).toEqual([])
  expect(
    allGateFiles.filter((filePath) => {
      return !filePath.endsWith('.test.ts')
    }),
  ).toEqual([])
})

test('component lifecycle gate spans route, SQLite outbox, and materialization boundaries', () => {
  expect(judgmentWorkflowComponentLifecycleTestFiles).toContain('src/server/routes/JudgmentsJobsRoutes.test.ts')
  expect(judgmentWorkflowComponentLifecycleTestFiles).toContain(
    'src/server/cron/judgmentsJobs/judgmentJobSqliteOutboxImport.test.ts',
  )
  expect(judgmentWorkflowComponentLifecycleTestFiles).toContain(
    'src/server/routes/judgmentsJobsRoutesDirtyMaterializationFreshness.test.ts',
  )
})

test('recovery gate covers durable replay, quarantine, retry, and claim recovery boundaries', () => {
  expect(judgmentWorkflowRecoveryTestFiles).toContain(
    'src/server/cron/judgmentsJobs/judgeWorkerCompletionJournal.test.ts',
  )
  expect(judgmentWorkflowRecoveryTestFiles).toContain('src/server/routes/JudgmentsJobsRoutes.crashContainment.test.ts')
  expect(judgmentWorkflowRecoveryTestFiles).toContain(
    'src/server/cron/judgmentsJobs/judgmentRequestAttemptLifecycle.test.ts',
  )
  expect(judgmentWorkflowRecoveryTestFiles).toContain(
    'src/server/cron/judgmentsJobs/requeueAbandonedSentPrompts.test.ts',
  )
})

test('runner produces an explicit Bun command without provider fallback flags', () => {
  const command = getJudgmentWorkflowTestCommand('component')

  expect(command.slice(0, 2)).toEqual(['bun', 'test'])
  expect(command.slice(2)).toEqual(
    judgmentWorkflowComponentLifecycleTestFiles.map((filePath) => {
      return resolve(filePath)
    }),
  )
  expect(command.join(' ')).not.toContain('fallback')
})

test('runner isolates every gate file in its own Bun process command', () => {
  for (const [gate, files] of [
    ['component', judgmentWorkflowComponentLifecycleTestFiles],
    ['focused', judgmentWorkflowFocusedTestFiles],
    ['recovery', judgmentWorkflowRecoveryTestFiles],
  ] as const) {
    expect(getJudgmentWorkflowTestCommands(gate)).toEqual(
      files.map((filePath) => {
        return ['bun', 'test', resolve(filePath)]
      }),
    )
  }
})
