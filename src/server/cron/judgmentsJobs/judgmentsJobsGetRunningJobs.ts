import {and, eq, or, sql} from 'drizzle-orm'

import * as schema from '../../../db/schema.ts'
import {env} from '../../utils/env.ts'
import type {AppDatabase} from '../../utils/getDatabase.ts'

// Track if we've already logged the SGLANG_MODEL message
let hasLoggedSglangModel = false

/**
 * Get running judgment jobs, filtered to only include projects
 * that use the model currently running on the inference server.
 *
 * This prevents sending requests for projects that use a different model
 * than what's configured in SGLANG_MODEL, avoiding unnecessary errors.
 */
export const judgmentsJobsGetRunningJobs = (db: AppDatabase) => {
  const sglangModel = env.SGLANG_MODEL

  const hasSglang = Boolean(sglangModel && sglangModel !== 'not set')

  if (!hasSglang && !hasLoggedSglangModel) {
    console.warn('[getRunningJobs] SGLANG_MODEL not set; non-codex jobs will not run')
    hasLoggedSglangModel = true
  }

  // SGLANG_MODEL should be a full HuggingFace ID (e.g., "XiaomiMiMo/MiMo-V2-Flash")
  // For backward compatibility, also match against lowercase and basename variants
  const sglangModelLower = hasSglang ? String(sglangModel).toLowerCase() : ''
  const sglangModelBaseName = hasSglang ? (String(sglangModel).split('/').pop() ?? String(sglangModel)) : ''

  if (hasSglang && !hasLoggedSglangModel) {
    console.log(`[getRunningJobs] Filtering non-codex jobs for SGLANG_MODEL: ${String(sglangModel)}`)
    hasLoggedSglangModel = true
  }

  const nonCodexModelCondition = hasSglang
    ? or(
        eq(schema.models.modelName, String(sglangModel)),
        eq(schema.models.modelName, sglangModelLower),
        eq(schema.models.modelName, sglangModelBaseName),
      )
    : sql`false`

  return db
    .select({
      id: schema.judgmentsJobs.id,
      projectId: schema.judgmentsJobs.projectId,
      modelProvider: schema.models.provider,
      modelName: schema.models.modelName,
    })
    .from(schema.judgmentsJobs)
    .innerJoin(schema.projects, eq(schema.judgmentsJobs.projectId, schema.projects.id))
    .innerJoin(schema.models, eq(schema.projects.modelId, schema.models.id))
    .where(
      and(
        eq(schema.judgmentsJobs.status, 'running'),
        eq(schema.projects.archived, false),
        or(eq(schema.models.provider, 'codex'), nonCodexModelCondition),
      ),
    )
}
