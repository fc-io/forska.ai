import {hostname} from 'node:os'

import {getEnv} from '../../utils/env.ts'

export const getDefaultJudgmentServerJobId = () => {
  const env = getEnv()
  const normalizedHostname = hostname().trim() || 'unknown-host'
  return `server-job-${normalizedHostname}-${String(env.API_SERVER_PORT)}-${process.pid}`
}
