type ProjectRow = {
  archived?: boolean
  deletePendingAt?: string | null
  delete_pending_at?: string | null
  id: string
  name?: string | null
}

type ReviewWarningResponse = {
  data?: {
    indexing?: {
      coverage?: {
        detailReadyArticleCount?: number | null
        reviewPageReadyArticleCount?: number | null
        totalArticleCount?: number | null
      }
      inFlightRefreshCount?: number | null
      maintenance?: {
        hasActionableFailures?: boolean
        hasHistoricalFailures?: boolean
        status?: string
        terminalDirtyWorkCount?: number
        terminalQuarantineCount?: number
        terminalRebuildChunkCount?: number
      }
      pendingRefreshCount?: number | null
      progressState?: string
      queuedRefreshCount?: number | null
      serving?: {readable?: boolean; usable?: boolean}
      status?: string
    }
  }
}

type ProjectReport = {
  coverage: NonNullable<NonNullable<ReviewWarningResponse['data']>['indexing']>['coverage']
  liveWorkCount: number
  maintenance: NonNullable<NonNullable<ReviewWarningResponse['data']>['indexing']>['maintenance']
  mismatches: string[]
  progressState: string | null
  projectId: string
  projectName: string
  serving: NonNullable<NonNullable<ReviewWarningResponse['data']>['indexing']>['serving']
  status: string | null
}

const apiBaseUrl = process.env.FORSKA_API_BASE_URL ?? 'http://127.0.0.1:3001'

const getJson = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(`${apiBaseUrl}${path}`, init)
  const text = await response.text()

  if (!response.ok) {
    throw new Error(`request ${path} failed with HTTP ${response.status}: ${text.slice(0, 500)}`)
  }

  return JSON.parse(text) as T
}

const postJson = async <T>(path: string, body: unknown): Promise<T> => {
  return getJson<T>(path, {body: JSON.stringify(body), headers: {'content-type': 'application/json'}, method: 'POST'})
}

const getActiveProjects = async () => {
  const response = await getJson<{data?: ProjectRow[]} | ProjectRow[]>('/api/projects')
  const projects = Array.isArray(response) ? response : (response.data ?? [])

  return projects.filter((project) => {
    return project.archived !== true && project.deletePendingAt == null && project.delete_pending_at == null
  })
}

const getNumber = (value: number | null | undefined) => {
  return Number(value ?? 0)
}

const getProjectReport = async (project: ProjectRow): Promise<ProjectReport> => {
  const warning = await postJson<ReviewWarningResponse>('/api/projectsreviewswarnings', {projectId: project.id})
  const indexing = warning.data?.indexing

  if (indexing === undefined) {
    return {
      coverage: undefined,
      liveWorkCount: 0,
      maintenance: undefined,
      mismatches: ['missing indexing payload'],
      progressState: null,
      projectId: project.id,
      projectName: project.name ?? project.id,
      serving: undefined,
      status: null,
    }
  }

  const coverage = indexing.coverage
  const serving = indexing.serving
  const maintenance = indexing.maintenance
  const liveWorkCount =
    getNumber(indexing.pendingRefreshCount)
    + getNumber(indexing.inFlightRefreshCount)
    + getNumber(indexing.queuedRefreshCount)
  const totalArticleCount = getNumber(coverage?.totalArticleCount)
  const hasCompleteReviewPageCoverage =
    totalArticleCount > 0
    && getNumber(coverage?.reviewPageReadyArticleCount) === totalArticleCount
    && getNumber(coverage?.detailReadyArticleCount) === totalArticleCount
  const isReadableAndIdle = serving?.readable === true && serving.usable === true && liveWorkCount === 0
  const mismatches: string[] = []

  if (hasCompleteReviewPageCoverage && isReadableAndIdle && indexing.status === 'failed') {
    mismatches.push('complete readable idle serving reported user-facing failed status')
  }

  if (hasCompleteReviewPageCoverage && isReadableAndIdle && indexing.progressState === 'failed') {
    mismatches.push('complete readable idle serving reported failed progressState')
  }

  if (hasCompleteReviewPageCoverage && isReadableAndIdle && maintenance?.hasActionableFailures === true) {
    mismatches.push('complete readable idle serving reported actionable maintenance failure')
  }

  if (maintenance === undefined) {
    mismatches.push('missing indexing.maintenance summary')
  }

  return {
    coverage,
    liveWorkCount,
    maintenance,
    mismatches,
    progressState: indexing.progressState ?? null,
    projectId: project.id,
    projectName: project.name ?? project.id,
    serving,
    status: indexing.status ?? null,
  }
}

const main = async () => {
  const projects = await getActiveProjects()
  const reports = await Promise.all(
    projects.map((project) => {
      return getProjectReport(project)
    }),
  )
  const failures = reports.filter((report) => {
    return report.mismatches.length > 0
  })

  console.log(JSON.stringify({apiBaseUrl, failures, projects: reports}, null, 2))

  if (failures.length > 0) {
    throw new Error(`review-serving warning status parity failed for ${failures.length} project(s)`)
  }
}

await main()
