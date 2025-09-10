import {apiClient} from './apiClient.ts'

export const createAgentJob = async (
  projectId: string,
  agentConfig?: unknown,
) => {
  try {
    const response = await apiClient.api.agentjobs.post({
      projectId,
      agentConfig,
    })
    if (response.error) {
      console.error('Error creating agent job:', response.error)
      throw new Error('Failed to create agent job')
    }

    if (!response.data) {
      throw new Error('No job data returned')
    }

    return response.data
  } catch (err) {
    console.error('Error creating agent job:', err)
    throw err
  }
}

export const getAgentJobState = async (jobId: string) => {
  try {
    const response = await apiClient.api.agentjobs({id: jobId}).get()

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

export const getAllAgentJobs = async (projectId?: string) => {
  try {
    const response = await apiClient.api.agentjobs.get({
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
