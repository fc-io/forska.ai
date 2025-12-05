import {eq} from 'drizzle-orm'

import {judgmentsJobs, tokenUse} from '../../../db/schema.ts'
import {getDatabase} from '../../utils/getDatabase.ts'

export const tokensRoutesGetFailedRequestById = async (id: string) => {
  const db = getDatabase()

  const [result] = await db
    .select({
      id: tokenUse.id,
      createdAt: tokenUse.createdAt,
      judgmentsJobId: tokenUse.judgmentsJobId,
      projectId: judgmentsJobs.projectId,
      modelName: tokenUse.sglangModel,
      failedRequests: tokenUse.failedRequests,
      failedRequestsDetails: tokenUse.failedRequestsDetails,
      totalTokens: tokenUse.totalTokens,
      userId: tokenUse.userId,
      sessionId: tokenUse.sessionId,
      requests: tokenUse.requests,
      successfulRequests: tokenUse.successfulRequests,
    })
    .from(tokenUse)
    .leftJoin(judgmentsJobs, eq(tokenUse.judgmentsJobId, judgmentsJobs.id))
    .where(eq(tokenUse.id, id))

  if (!result) {
    return {success: false, error: 'Failed request not found'}
  }

  return {success: true, data: result}
}
