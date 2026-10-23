import {getPdfFetchJobFromDatabase} from '../../services/pdfFetchJobs.ts'

export const articlesRoutesGetPdfFetchJob = async ({params}: {params: {jobId: string}}) => {
  const job = await getPdfFetchJobFromDatabase(params.jobId)
  if (!job) {
    throw new Error('Job not found')
  }
  return {job}
}
