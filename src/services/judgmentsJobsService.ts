import {apiClient} from './apiClient.ts'
import {handleApiResponse} from './utils/handleApiResponse'

const buildMissingJob = () => {
  return {
    id: 'not found',
    createdAt: '',
    updatedAt: '',
    projectId: 'not found',
    status: '',
    error: '',
    projectName: '',
    promptStats: {ready: 0, sent: 0, judged: 0},
  }
}

export const createJudgmentsJob = async (projectId: string, agentConfig?: unknown) => {
  const response = await apiClient.api.judgmentsjobs.post({projectId, agentConfig})
  return handleApiResponse(response, 'Failed to create judgments job')
}

export const fetchJudgmentsJobs = async () => {
  const response = await apiClient.api.judgmentsjobs.get({query: {}})
  const result = handleApiResponse(response, 'Failed to fetch judgment jobs')
  return result && result.data ? result.data : []
}

export const getJudgmentsJobById = async (jobId: string) => {
  const response = await apiClient.api.judgmentsjobs({id: jobId}).get()
  const result = handleApiResponse(response, 'Failed to fetch job state')
  return result ? result : buildMissingJob()
}

export const getAllJudgmentsJobs = async () => {
  const response = await apiClient.api.judgmentsjobs.get()
  return handleApiResponse(response, 'Failed to fetch all jobs')
}

export const updateJudgmentsJobStatus = async (
  jobId: string,
  status:
    | 'not_started'
    | 'waiting_on_llm_connection'
    | 'waiting_on_db_connection'
    | 'running'
    | 'paused_by_user'
    | 'paused_by_admin'
    | 'failed'
    | 'completed'
    | 'project_removed',
) => {
  const response = await apiClient.api.judgmentsjobs({id: jobId}).patch({status})
  return handleApiResponse(response, 'Failed to update job status')
}

export const pauseJudgmentsJob = (jobId: string) => {
  return updateJudgmentsJobStatus(jobId, 'paused_by_admin')
}

export const startJudgmentsJob = (jobId: string) => {
  return updateJudgmentsJobStatus(jobId, 'running')
}

export const deleteJudgmentsJob = async (jobId: string) => {
  const response = await apiClient.api.judgmentsjobs({id: jobId}).delete()
  return handleApiResponse(response, 'Failed to delete job')
}

export const getJudgmentsJobUnassessedArticles = async (jobId: string) => {
  const response = await apiClient.api['judgmentsjobs-unassessed-articles'].get({query: {jobId}})
  const result = handleApiResponse(response, 'Failed to fetch unassessed articles for job')
  return result?.data ?? []
}

export const getTotalTokenUsage = async () => {
  const response = await apiClient.api['judgmentsjobs-total-token-usage'].get()
  const result = handleApiResponse(response, 'Failed to fetch total token usage')
  return result?.data ?? {totalTokens: 0, totalPromptTokens: 0, totalCompletionTokens: 0}
}
