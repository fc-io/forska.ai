import {and, eq, or, sql} from 'drizzle-orm'
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import * as schema from '../../../db/schema.ts'
import {env} from '../../utils/env.ts'

// Track if we've already logged the SGLANG_MODEL message
let hasLoggedSglangModel = false

/**
 * Get running judgment jobs, filtered to only include projects
 * that use the model currently running on the inference server.
 *
 * This prevents sending requests for projects that use a different model
 * than what's configured in SGLANG_MODEL, avoiding unnecessary errors.
 */
export const judgmentsJobsGetRunningJobs = (db: PostgresJsDatabase<typeof schema>) => {
  const sglangModel = env.SGLANG_MODEL

  // If SGLANG_MODEL is not set, return no jobs and warn
  if (!sglangModel || sglangModel === 'not set') {
    console.warn(
      '[getRunningJobs] WARNING: SGLANG_MODEL not set. No jobs will be processed. Set SGLANG_MODEL env variable to enable inference.',
    )
    // Return a query that will always return empty results (WHERE false)
    return db
      .select({id: schema.judgmentsJobs.id, projectId: schema.judgmentsJobs.projectId})
      .from(schema.judgmentsJobs)
      .where(sql`false`)
  }

  // SGLANG_MODEL should be a full HuggingFace ID (e.g., "XiaomiMiMo/MiMo-V2-Flash")
  // For backward compatibility, also match against lowercase and basename variants
  const sglangModelLower = sglangModel.toLowerCase()
  const sglangModelBaseName = sglangModel.split('/').pop() ?? sglangModel

  if (!hasLoggedSglangModel) {
    console.log(`[getRunningJobs] Filtering jobs for SGLANG_MODEL: ${sglangModel}`)
    hasLoggedSglangModel = true
  }

  // Filter jobs to only include those whose project uses the matching model
  // Primary match: exact HuggingFace ID
  // Fallback: lowercase match or basename match (for migration period)
  return db
    .select({id: schema.judgmentsJobs.id, projectId: schema.judgmentsJobs.projectId})
    .from(schema.judgmentsJobs)
    .innerJoin(schema.projects, eq(schema.judgmentsJobs.projectId, schema.projects.id))
    .innerJoin(schema.models, eq(schema.projects.modelId, schema.models.id))
    .where(
      and(
        eq(schema.judgmentsJobs.status, 'running'),
        or(
          eq(schema.models.modelName, sglangModel), // Exact HuggingFace ID match
          eq(schema.models.modelName, sglangModelLower), // Lowercase variant
          eq(schema.models.modelName, sglangModelBaseName), // Basename only (e.g., "MiMo-V2-Flash")
        ),
      ),
    )
}
