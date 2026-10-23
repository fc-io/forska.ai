import type {ProjectPromptCleanupSummary} from './projectEditTypes.ts'

export const logProjectPromptCleanupSummary = (params: {projectId: string; summary: ProjectPromptCleanupSummary}) => {
  console.log(
    JSON.stringify({
      changedPromptLinks: params.summary.changedPromptLinks.map((link) => {
        return {newPromptId: link.newPromptId, oldPromptId: link.oldPromptId, projectPromptId: link.projectPromptId}
      }),
      deletedHumanPromptAnswers: params.summary.deletedHumanPromptAnswers,
      event: 'project_prompt_cleanup_summary',
      keptSharedLlmJudgments: params.summary.keptSharedLlmJudgments,
      projectId: params.projectId,
      skippedComparisonPromptReferencedJudgments: params.summary.skippedComparisonPromptReferencedJudgments,
      softDeletedLlmJudgments: params.summary.softDeletedLlmJudgments,
    }),
  )
}
