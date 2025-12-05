import {desc, eq, sql} from 'drizzle-orm'

import {tokenUse} from '../../../db/schema.ts'
import {getDatabase} from '../../utils/getDatabase.ts'

type GetFailedRequestsParams = {limit?: number; offset?: number}

export const tokensRoutesGetFailedRequests = async ({limit = 50, offset = 0}: GetFailedRequestsParams) => {
  const db = getDatabase()

  const result = await db
    .select({
      id: tokenUse.id,
      createdAt: tokenUse.createdAt,
      judgmentsJobId: tokenUse.judgmentsJobId,
      modelName: tokenUse.sglangModel,
      failedRequests: tokenUse.failedRequests,
      failedRequestsDetails: tokenUse.failedRequestsDetails,
      totalTokens: tokenUse.totalTokens,
    })
    .from(tokenUse)
    .where(eq(tokenUse.hasFailedRequests, true))
    .orderBy(desc(tokenUse.createdAt))
    .limit(limit)
    .offset(offset)

  // Get total count for pagination
  const [countResult] = await db
    .select({count: sql<number>`count(*)::int`})
    .from(tokenUse)
    .where(eq(tokenUse.hasFailedRequests, true))

  return {success: true, data: result, total: countResult?.count ?? 0}
}
