import {deleteUnexpectedJudgments} from './deleteUnexpectedJudgments.ts'
import {fetchProjectScope} from './fetchProjectScope.ts'
import {getPromptSelection} from './getPromptSelection.ts'
import {getUnexpectedAnswersSummary} from './getUnexpectedAnswersSummary.ts'
import {isOpenEndedType} from './promptTypeOptions.ts'

type AutoSyncAllProgress = {
  status: 'idle' | 'running' | 'completed' | 'error'
  totalPrompts: number
  processedPrompts: number
  currentPromptId: string | null
  currentPromptHeading: string | null
  totalDeleted: number
  deletedByPrompt: Array<{promptId: string; promptHeading: string; deleted: number}>
  startedAt: Date | null
  completedAt: Date | null
  error: string | null
}

const autoSyncAllProgress: AutoSyncAllProgress = {
  status: 'idle',
  totalPrompts: 0,
  processedPrompts: 0,
  currentPromptId: null,
  currentPromptHeading: null,
  totalDeleted: 0,
  deletedByPrompt: [],
  startedAt: null,
  completedAt: null,
  error: null,
}

export const getAutoSyncAllProgress = () => {
  return {...autoSyncAllProgress, deletedByPrompt: [...autoSyncAllProgress.deletedByPrompt]}
}

export const runAutoSyncAllAsync = async (projectId: string | null) => {
  if (autoSyncAllProgress.status === 'running') {
    return {started: false, message: 'Auto-sync already in progress'}
  }

  autoSyncAllProgress.status = 'running'
  autoSyncAllProgress.totalPrompts = 0
  autoSyncAllProgress.processedPrompts = 0
  autoSyncAllProgress.currentPromptId = null
  autoSyncAllProgress.currentPromptHeading = null
  autoSyncAllProgress.totalDeleted = 0
  autoSyncAllProgress.deletedByPrompt = []
  autoSyncAllProgress.startedAt = new Date()
  autoSyncAllProgress.completedAt = null
  autoSyncAllProgress.error = null

  const runSync = async () => {
    try {
      console.log(
        `[AutoSyncAll] Starting auto-sync all unexpected answers${projectId ? ` for project ${projectId}` : ''}...`,
      )

      const promptsToProcess = await getPromptSelection(projectId, null)
      const projectScope = projectId ? await fetchProjectScope(projectId) : null
      const filteredPrompts = promptsToProcess.filter((prompt) => {
        return !isOpenEndedType(prompt.type)
      })

      autoSyncAllProgress.totalPrompts = filteredPrompts.length
      console.log(`[AutoSyncAll] Found ${filteredPrompts.length} prompts with defined types to process`)

      for (const prompt of filteredPrompts) {
        autoSyncAllProgress.currentPromptId = prompt.id
        autoSyncAllProgress.currentPromptHeading = prompt.promptHeading ?? 'Untitled'

        const {expectedOptions, unexpectedAnswers} = await getUnexpectedAnswersSummary({
          promptId: prompt.id,
          promptType: prompt.type,
          projectScope,
        })

        if (expectedOptions.length === 0) {
          autoSyncAllProgress.processedPrompts += 1
          continue
        }

        let promptDeleted = 0
        for (const unexpectedAnswer of unexpectedAnswers) {
          const result = await deleteUnexpectedJudgments(projectId, prompt.id, unexpectedAnswer.value)
          promptDeleted += result.deleted
        }

        if (promptDeleted > 0) {
          autoSyncAllProgress.totalDeleted += promptDeleted
          autoSyncAllProgress.deletedByPrompt.push({
            promptId: prompt.id,
            promptHeading: prompt.promptHeading ?? 'Untitled',
            deleted: promptDeleted,
          })
          console.log(
            `[AutoSyncAll] Deleted ${promptDeleted} unexpected judgments for prompt "${prompt.promptHeading ?? prompt.id}"`,
          )
        }

        autoSyncAllProgress.processedPrompts += 1
      }

      autoSyncAllProgress.status = 'completed'
      autoSyncAllProgress.completedAt = new Date()
      autoSyncAllProgress.currentPromptId = null
      autoSyncAllProgress.currentPromptHeading = null
      console.log(
        `[AutoSyncAll] Completed! Processed ${autoSyncAllProgress.processedPrompts} prompts, deleted ${autoSyncAllProgress.totalDeleted} unexpected judgments`,
      )
    } catch (error) {
      autoSyncAllProgress.status = 'error'
      autoSyncAllProgress.error = error instanceof Error ? error.message : 'Unknown error'
      autoSyncAllProgress.completedAt = new Date()
      console.error('[AutoSyncAll] Error:', error)
    }
  }

  void runSync()

  return {started: true, message: 'Auto-sync all started'}
}
