import {apiClient} from './apiClient.ts'

export const createJudgmentsJob = async (
  projectId: string,
  agentConfig?: unknown,
) => {
  try {
    const response = await apiClient.api.judgmentsjobs.post({
      projectId,
      agentConfig,
    })
    if (response.error) {
      console.error('Error creating judgments job:', response.error)
      throw new Error('Failed to create judgments job')
    }

    if (!response.data) {
      throw new Error('No job data returned')
    }

    return response.data
  } catch (err) {
    console.error('Error creating judgments job:', err)
    throw err
  }
}

export const getJudgmentsJobState = async (jobId: string) => {
  try {
    const response = await apiClient.api.judgmentsjobs({id: jobId}).get()

    if (response.error) {
      console.error('Error fetching job state:', response.error)
      throw new Error('Failed to fetch job state')
    }

    if (!response.data) {
      throw new Error('No job data returned')
    }

    return response.data
  } catch (err) {
    console.error('Error fetching job state:', err)
    throw err
  }
}

export const getAllJudgmentsJobs = async (projectId?: string) => {
  try {
    const response = await apiClient.api.judgmentsjobs.get({
      query: projectId ? {projectId} : undefined,
    })

    if (response.error) {
      console.error('Error fetching all jobs:', response.error)
      throw new Error('Failed to fetch all jobs')
    }

    if (!response.data) {
      throw new Error('No jobs data returned')
    }

    return response.data
  } catch (err) {
    console.error('Error fetching all jobs:', err)
    throw err
  }
}
