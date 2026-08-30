import {expect, test} from '@playwright/test'

const getRequiredEnvironmentValue = (key: string) => {
  const value = process.env[key]?.trim()

  if (!value) {
    throw new Error(`${key} is required for the judgment workflow browser smoke`)
  }

  return value
}

const projectId = getRequiredEnvironmentValue('FORSKA_JUDGMENT_BROWSER_PROJECT_ID')
const projectName = getRequiredEnvironmentValue('FORSKA_JUDGMENT_BROWSER_PROJECT_NAME')
const jobId = getRequiredEnvironmentValue('FORSKA_JUDGMENT_BROWSER_JOB_ID')
const articleId = getRequiredEnvironmentValue('FORSKA_JUDGMENT_BROWSER_ARTICLE_ID')
const fixtureId = getRequiredEnvironmentValue('FORSKA_JUDGMENT_BROWSER_FIXTURE_ID')
const ownerOrigin = getRequiredEnvironmentValue('FORSKA_JUDGMENT_BROWSER_OWNER_ORIGIN')
const seedToken = getRequiredEnvironmentValue('FORSKA_JUDGMENT_BROWSER_SEED_TOKEN')
const modelId = getRequiredEnvironmentValue('FORSKA_JUDGMENT_BROWSER_MODEL_ID')
const promptId = getRequiredEnvironmentValue('FORSKA_JUDGMENT_BROWSER_PROMPT_ID')

test('discovers and drives a real judgment job through start, result, pause, drain, and review UI', async ({page}) => {
  await page.goto('/admin/jobs')
  await expect(page.getByRole('heading', {name: 'Judgment Jobs'})).toBeVisible()
  const projectLink = page.getByRole('link', {name: projectName}).first()
  await expect(projectLink).toBeVisible()
  await projectLink.click()

  await expect(page).toHaveURL(new RegExp(`/admin/jobs/${jobId}`))
  await expect(page.getByRole('button', {name: 'Start Job', exact: true})).toBeVisible()
  await page.getByRole('button', {name: 'Start Job', exact: true}).click()
  await expect(page.getByRole('button', {name: 'Pause Job'})).toBeVisible({timeout: 30_000})
  await expect(page.getByRole('heading', {name: 'Pipeline Summary'})).toBeVisible()
  await expect(page.getByRole('heading', {name: 'Prompt Queue'})).toBeVisible()
  await expect(page.getByText('Judged', {exact: true})).toBeVisible()

  await expect
    .poll(
      async () => {
        try {
          const response = await page.request.post(`${ownerOrigin}/api/test/judgment-workflow-real-codex/evidence`, {
            data: {modelId, projectId, promptId, token: seedToken},
          })
          const topologyResponse = await page.request.post(
            `${ownerOrigin}/api/test/judgment-workflow-topology/evidence`,
            {data: {fixtureId, token: seedToken}},
          )
          const body = (await response.json()) as {
            data: {judgments: Array<{articleId: string}>; visibleProjectionCount: number}
          }
          const topologyBody = (await topologyResponse.json()) as {
            data: {judgments: Array<{count: number; projectId: string}>}
          }
          const projectJudgments = topologyBody.data.judgments.find((row) => {
            return row.projectId === projectId
          })

          return {
            canonicalCount: Number(projectJudgments?.count ?? 0),
            visibleProjectionCount: body.data.visibleProjectionCount,
          }
        } catch {
          return 0
        }
      },
      {timeout: 120_000},
    )
    .toEqual({canonicalCount: 2, visibleProjectionCount: 1})

  await page.reload()
  await expect
    .poll(
      async () => {
        await page.reload()
        return page.getByText('Unassessed Articles', {exact: true}).locator('..').textContent()
      },
      {timeout: 60_000},
    )
    .toContain('0')
  const promptQueue = page.getByRole('heading', {name: 'Prompt Queue'}).locator('..').locator('..')
  await expect(promptQueue.getByText('Ready', {exact: true}).locator('..')).toContainText('0')
  await expect(promptQueue.getByText('Judged', {exact: true}).locator('..')).toContainText('2')

  await page.getByRole('button', {name: 'Pause Job'}).click()
  await expect(page.getByRole('button', {name: 'Start Job', exact: true})).toBeVisible({timeout: 30_000})
  await page.getByRole('button', {name: 'Drain Storage'}).click()

  await expect
    .poll(
      async () => {
        const response = await page.request.get(`/api/judgmentsjobs/${jobId}`)
        const body = (await response.json()) as {
          data?: {
            status?: string
            storageHealth?: {
              hasOutboxRows?: boolean
              hasQueueRows?: boolean
              sqliteFileBytes?: number | null
              walBytes?: number
            }
            storageState?: string
          }
          status?: string
          storageHealth?: {
            hasOutboxRows?: boolean
            hasQueueRows?: boolean
            sqliteFileBytes?: number | null
            walBytes?: number
          }
          storageState?: string
        }
        const job = body.data ?? body

        return {
          hasOutboxRows: job.storageHealth?.hasOutboxRows,
          hasQueueRows: job.storageHealth?.hasQueueRows,
          status: job.status,
          storageState: job.storageState,
          walBytes: job.storageHealth?.walBytes,
        }
      },
      {timeout: 90_000},
    )
    .toEqual({hasOutboxRows: false, hasQueueRows: false, status: 'paused', storageState: 'drained', walBytes: 0})
  const cleanupResponse = await page.request.post(`${ownerOrigin}/api/test/judgment-workflow-topology/cleanup-stale`, {
    data: {token: seedToken},
  })
  expect(cleanupResponse.ok()).toBe(true)
  await expect
    .poll(
      async () => {
        const response = await page.request.post(`${ownerOrigin}/api/test/judgment-workflow-topology/evidence`, {
          data: {fixtureId, jobIds: [jobId], token: seedToken},
        })
        const body = (await response.json()) as {
          data: {
            jobEvidence: Array<{
              artifacts: {lease: boolean; shm: boolean; sqlite: boolean; wal: boolean}
              jobId: string
            }>
          }
        }
        const jobEvidence = body.data.jobEvidence.find((job) => {
          return job.jobId === jobId
        })

        return jobEvidence?.artifacts
      },
      {timeout: 30_000},
    )
    .toEqual({lease: false, shm: false, sqlite: false, wal: false})
  await page.reload()
  await expect(page.getByText('Storage: Drained', {exact: true})).toBeVisible()

  await page.goto(`/projects/${projectId}/reviews-llm/${encodeURIComponent(articleId)}`)
  await expect(page.getByText('Topology article A', {exact: true})).toBeVisible({timeout: 60_000})
  const judgmentExplanations = page.getByText(/deterministic topology response/i)
  await expect(judgmentExplanations).toHaveCount(2)
  await expect(judgmentExplanations.first()).toBeVisible()
})
