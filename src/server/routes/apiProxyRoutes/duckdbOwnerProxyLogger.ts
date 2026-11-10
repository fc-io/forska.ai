import {createRateLimitedLogger} from '../../utils/rateLimitedLogger.ts'

// 'both': proxy failures and timeouts must reach the runtime JSONL log (api-server-*.jsonl), not only the terminal.
export const duckdbOwnerProxyLogger = createRateLimitedLogger({sink: 'both', windowMs: 30_000})
