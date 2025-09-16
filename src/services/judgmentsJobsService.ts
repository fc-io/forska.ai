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
    articleStats: {ready: 0, sent: 0, judged: 0},
    unassessedArticlesCount: 0,
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
