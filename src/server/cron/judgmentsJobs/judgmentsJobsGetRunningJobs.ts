import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {escapeSqlString} from '../../services/appQueryHelpers.ts'
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
export const judgmentsJobsGetRunningJobs = async () => {
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
    ? `(
        m.model_name = '${escapeSqlString(String(sglangModel))}'
        OR m.model_name = '${escapeSqlString(sglangModelLower)}'
        OR m.model_name = '${escapeSqlString(sglangModelBaseName)}'
      )`
    : 'FALSE'

  return getAppDatabaseService().queryJson<{
    id: string
    projectId: string
    modelProvider: string | null
    modelName: string | null
  }>(`
    SELECT
      jj.id AS id,
      jj.project_id AS projectId,
      m.provider AS modelProvider,
      m.model_name AS modelName
    FROM app.judgment_job jj
    INNER JOIN app.project p ON jj.project_id = p.id
    INNER JOIN app.model m ON p.model_id = m.id
    WHERE jj.status = 'running'
      AND p.archived = FALSE
      AND (m.provider = 'codex' OR ${nonCodexModelCondition})
  `)
}
