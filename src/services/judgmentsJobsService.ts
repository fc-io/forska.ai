import {apiClient} from './apiClient.ts'
import {handleApiResponse} from './utils/handleApiResponse'

export const createJudgmentsJob = async (projectId: string, agentConfig?: unknown) => {
  const response = await apiClient.api.judgmentsjobs.post({projectId, agentConfig})
  return handleApiResponse(response, 'Failed to create judgments job')
}

export const fetchJudgmentsJobs = async () => {
  const response = await apiClient.api.judgmentsjobs.get({query: {}})
  const result = handleApiResponse(response, 'Failed to fetch judgment jobs')
  return result.data ?? []
}

export const getJudgmentsJobState = async (jobId: string) => {
  const response = await apiClient.api.judgmentsjobs({id: jobId}).get()
  return handleApiResponse(response, 'Failed to fetch job state')
}

export const getAllJudgmentsJobs = async () => {
  const response = await apiClient.api.judgmentsjobs.get()
  return handleApiResponse(response, 'Failed to fetch all jobs')
}
