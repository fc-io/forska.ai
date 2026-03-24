import {hostname} from 'node:os'

import {env} from '../../utils/env.ts'

export const getDefaultJudgmentServerJobId = () => {
  const normalizedHostname = hostname().trim() || 'unknown-host'
  return `server-job-${normalizedHostname}-${String(env.API_SERVER_PORT)}-${process.pid}`
}
