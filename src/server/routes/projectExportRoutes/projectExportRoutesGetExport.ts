import type {Context} from 'elysia'

import {assertProjectIsActive} from '../projectsRoutes/projectAccessGuard.ts'
import {getExportJob} from './getExportJob.ts'

export const projectExportRoutesGetExport = async ({
  params,
  set,
}: {
  params: {id: string; jobId: string}
  set: Context['set']
}) => {
  await assertProjectIsActive(params.id)

  const job = await getExportJob(params.id, params.jobId)

  if (!job) {
    set.status = 404
    return {error: 'Export job not found', success: false}
  }

  return {
    downloadUrl: job.status === 'completed' ? `/api/projects/${params.id}/export/${params.jobId}/download` : null,
    job: {jobId: params.jobId, status: job.status},
    success: true,
  }
}
