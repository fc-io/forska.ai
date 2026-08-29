export const judgmentWorkflowFocusedTestFiles = [
  'src/server/routes/JudgmentsJobsRoutes.test.ts',
  'src/server/routes/judgmentsJobsRoutesApiReadModel.test.ts',
  'src/server/routes/judgmentsJobsRoutesDirtyMaterializationFreshness.test.ts',
  'src/server/cron/judgmentsJobs/judgmentDispatchRuntime.test.ts',
  'src/server/cron/judgmentsJobs/judgmentJobRepair.test.ts',
  'src/server/cron/judgmentsJobs/judgmentJobSqliteOutboxImport.test.ts',
  'src/server/cron/judgmentsJobs/judgmentJobSqliteService.test.ts',
  'src/server/cron/judgmentsJobs/judgmentsJobsAddToQueue.test.ts',
  'src/server/cron/judgmentsJobs/judgmentsJobsCleanupStale.test.ts',
  'src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM.test.ts',
] as const

export const judgmentWorkflowComponentLifecycleTestFiles = [
  'src/server/routes/JudgmentsJobsRoutes.test.ts',
  'src/server/routes/judgmentsJobsRoutesDirtyMaterializationFreshness.test.ts',
  'src/server/cron/judgmentsJobs/judgmentJobSqliteOutboxImport.test.ts',
  'src/server/cron/judgmentsJobs/judgmentJobSqliteService.test.ts',
] as const

export const judgmentWorkflowRecoveryTestFiles = [
  'src/server/routes/JudgmentsJobsRoutes.crashContainment.test.ts',
  'src/server/cron/judgmentsJobs/judgeWorkerCompletionJournal.test.ts',
  'src/server/cron/judgmentsJobs/judgmentJobRepair.test.ts',
  'src/server/cron/judgmentsJobs/judgmentJobSqliteOutboxImport.test.ts',
  'src/server/cron/judgmentsJobs/judgmentJobSqliteService.test.ts',
  'src/server/cron/judgmentsJobs/judgmentRequestAttemptLifecycle.test.ts',
  'src/server/cron/judgmentsJobs/judgmentsJobsCleanupStale.test.ts',
  'src/server/cron/judgmentsJobs/judgmentsJobsGetRunningJobs.test.ts',
  'src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM.test.ts',
  'src/server/cron/judgmentsJobs/providerAdmissionLeaseFencing.test.ts',
  'src/server/cron/judgmentsJobs/requeueAbandonedSentPrompts.test.ts',
] as const

export const judgmentWorkflowTestFilesByGate = {
  component: judgmentWorkflowComponentLifecycleTestFiles,
  focused: judgmentWorkflowFocusedTestFiles,
  recovery: judgmentWorkflowRecoveryTestFiles,
} as const

export type JudgmentWorkflowTestGate = keyof typeof judgmentWorkflowTestFilesByGate
