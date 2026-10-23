import type {Context} from 'elysia'

import {getCodexAppDeviceLoginJob} from '../../providers/transports/codexAppTransport.ts'

export const modelsRoutesGetCodexLoginJob = async ({params, set}: {params: {jobId: string}; set: Context['set']}) => {
  const job = getCodexAppDeviceLoginJob(params.jobId)

  if (!job) {
    set.status = 404
    return {data: null, error: 'Login job not found'}
  }

  return {data: job, error: null}
}
