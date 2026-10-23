import {createRateLimitedLogger} from '../../utils/rateLimitedLogger.ts'

export const providerHealthLogWindowMs = 60_000
export const providerHealthLogger = createRateLimitedLogger({sink: 'both', windowMs: providerHealthLogWindowMs})
