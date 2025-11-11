import {env} from '../../utils/env.ts'

export const getMaxNumberOfInflightRequests = (): number => {
  const {SGLANG_MAX_RUNNING_REQUESTS} = env

  return SGLANG_MAX_RUNNING_REQUESTS * 4
}
