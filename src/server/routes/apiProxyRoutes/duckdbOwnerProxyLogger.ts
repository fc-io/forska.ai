import {createRateLimitedLogger} from '../../utils/rateLimitedLogger.ts'

export const duckdbOwnerProxyLogger = createRateLimitedLogger({windowMs: 30_000})
