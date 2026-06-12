import {getAppDatabaseService} from '../appDatabaseService.ts'
import {getJsonValue, getQuotedStringList, getSqlLiteral, getTimestampLiteral} from '../appQueryHelpers.ts'

type TargetStateDirtyTokenRunner = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
}

type OptionalTargetStateDirtyTokenRunner = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run?: (statement: string) => Promise<void>
}

type InitializeTargetStateCoverageParams = {now?: Date; runner?: TargetStateDirtyTokenRunner}

type AdvanceTargetStateDirtyTokensParams = {
  now?: Date
  reason: string
  runner?: TargetStateDirtyTokenRunner
  surfaces: readonly ProjectTransferTargetStateSafetySurface[]
}

type AdvanceGlobalUnknownTokenParams = {now?: Date; reason: string; runner?: TargetStateDirtyTokenRunner}

type GetTargetStateSnapshotParams = {runner?: OptionalTargetStateDirtyTokenRunner}

type CoverageRow = {
  coverageCodeVersion: string
  coveredSurfacesJson: unknown
  dependencyFingerprintAlgorithm: string
  dependencyFingerprintCodeVersion: string
  initializedAt: Date | string
  updatedAt: Date | string
}

type DirtyTokenRow = {dirtyToken: number; surface: string}

type UnknownTokenRow = {dirtyToken: number}

export const projectTransferTargetStateCoverageCodeVersion = 'project-transfer-target-state-coverage-v1'
export const projectTransferDependencyFingerprintAlgorithm = 'project-transfer-snapshot-fingerprint'
export const projectTransferDependencyFingerprintCodeVersion = 'provider-model-snapshot-v1'

export const projectTransferTargetStateSafetySurfaces = [
  'project',
  'article',
  'articleIdentifier',
  'importRoute',
  'projectImportRoute',
  'projectArticle',
  'prompt',
  'projectPrompt',
  'judgment',
  'judgmentAssessment',
  'humanJudgment',
  'humanJudgmentSummary',
  'review',
  'model',
  'providerConnection',
  'importedSnapshotMarker',
  'snapshotFingerprintInput',
  'projectTransferHistory',
] as const

export type ProjectTransferTargetStateSafetySurface = (typeof projectTransferTargetStateSafetySurfaces)[number]

export type ProjectTransferTargetStateCoverageVersion = {
  coverageCodeVersion: string
  coveredSurfaces: ProjectTransferTargetStateSafetySurface[]
  dependencyFingerprintAlgorithm: string
  dependencyFingerprintCodeVersion: string
  initializedAt: string
  updatedAt: string
}

export type ProjectTransferTargetStateDirtyTokenSnapshot = {
  capturedAt: string
  coverage: ProjectTransferTargetStateCoverageVersion | null
  globalUnknownToken: number
  tokens: Partial<Record<ProjectTransferTargetStateSafetySurface, number>>
}

export type ProjectTransferTargetStateDirtyTokenAdvance = {
  dirtyToken: number
  surface: ProjectTransferTargetStateSafetySurface
}

const projectTransferTargetStateSurfaceSet = new Set<string>(projectTransferTargetStateSafetySurfaces)

const getRunner = (runner?: OptionalTargetStateDirtyTokenRunner) => {
  return runner ?? getAppDatabaseService()
}

const getJsonLiteral = (value: unknown) => {
  return `CAST(${getSqlLiteral(JSON.stringify(value))} AS JSON)`
}

const getDateIso = (value: Date | string) => {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

const getNow = (now?: Date) => {
  return now ?? new Date()
}

const getUniqueSurfaces = (surfaces: readonly ProjectTransferTargetStateSafetySurface[]) => {
  return projectTransferTargetStateSafetySurfaces.filter((surface) => {
    return surfaces.includes(surface)
  })
}

const assertValidSurfaces = (surfaces: readonly ProjectTransferTargetStateSafetySurface[]) => {
  const invalidSurface = surfaces.find((surface) => {
    return !projectTransferTargetStateSurfaceSet.has(surface)
  })

  if (invalidSurface) {
    throw new Error(`Project transfer target-state dirty token surface is unknown: ${invalidSurface}`)
  }
}

const getCoverageVersion = (row: CoverageRow | null): ProjectTransferTargetStateCoverageVersion | null => {
  const coveredSurfaces = getJsonValue(row?.coveredSurfacesJson)
  const validSurfaces = Array.isArray(coveredSurfaces)
    ? coveredSurfaces.filter((surface): surface is ProjectTransferTargetStateSafetySurface => {
        return typeof surface === 'string' && projectTransferTargetStateSurfaceSet.has(surface)
      })
    : []

  return row === null
    ? null
    : {
        coverageCodeVersion: row.coverageCodeVersion,
        coveredSurfaces: validSurfaces,
        dependencyFingerprintAlgorithm: row.dependencyFingerprintAlgorithm,
        dependencyFingerprintCodeVersion: row.dependencyFingerprintCodeVersion,
        initializedAt: getDateIso(row.initializedAt),
        updatedAt: getDateIso(row.updatedAt),
      }
}

const getTargetStateCoverageVersion = async (runner: OptionalTargetStateDirtyTokenRunner) => {
  const [row] = await runner.queryJson<CoverageRow>(`
    SELECT
      coverage_code_version AS coverageCodeVersion,
      TO_JSON(covered_surfaces_json) AS coveredSurfacesJson,
      dependency_fingerprint_algorithm AS dependencyFingerprintAlgorithm,
      dependency_fingerprint_code_version AS dependencyFingerprintCodeVersion,
      initialized_at AS initializedAt,
      updated_at AS updatedAt
    FROM app.project_transfer_target_state_coverage
    WHERE id = 'current'
    LIMIT 1
  `)

  return getCoverageVersion(row ?? null)
}

const getGlobalUnknownToken = async (runner: OptionalTargetStateDirtyTokenRunner) => {
  const [row] = await runner.queryJson<UnknownTokenRow>(`
    SELECT CAST(dirty_token AS INTEGER) AS dirtyToken
    FROM app.project_transfer_target_state_unknown_token
    WHERE id = 'global'
    LIMIT 1
  `)

  return row?.dirtyToken ?? 0
}

const getTargetStateDirtyTokenRows = async (runner: OptionalTargetStateDirtyTokenRunner) => {
  const rows = await runner.queryJson<DirtyTokenRow>(`
    SELECT surface, CAST(dirty_token AS INTEGER) AS dirtyToken
    FROM app.project_transfer_target_state_dirty_token
    WHERE surface IN (${getQuotedStringList([...projectTransferTargetStateSafetySurfaces]).join(', ')})
    ORDER BY surface ASC
  `)

  return rows.reduce<Partial<Record<ProjectTransferTargetStateSafetySurface, number>>>((tokens, row) => {
    return projectTransferTargetStateSurfaceSet.has(row.surface)
      ? {...tokens, [row.surface as ProjectTransferTargetStateSafetySurface]: row.dirtyToken}
      : tokens
  }, {})
}

const ensureGlobalUnknownToken = async (runner: TargetStateDirtyTokenRunner) => {
  await runner.run(`
    INSERT INTO app.project_transfer_target_state_unknown_token (id)
    VALUES ('global')
    ON CONFLICT(id) DO NOTHING
  `)
}

const ensureTargetStateDirtyTokenRows = async (
  runner: TargetStateDirtyTokenRunner,
  surfaces: readonly ProjectTransferTargetStateSafetySurface[],
) => {
  const uniqueSurfaces = getUniqueSurfaces(surfaces)

  return uniqueSurfaces.length === 0
    ? undefined
    : runner.run(`
        INSERT INTO app.project_transfer_target_state_dirty_token (surface)
        VALUES ${uniqueSurfaces
          .map((surface) => {
            return `(${getSqlLiteral(surface)})`
          })
          .join(', ')}
        ON CONFLICT(surface) DO NOTHING
      `)
}

const withTransaction = <T>(
  runner: TargetStateDirtyTokenRunner | undefined,
  work: (tx: TargetStateDirtyTokenRunner) => Promise<T>,
) => {
  return runner ? work(runner) : (getAppDatabaseService().transaction(work) as Promise<T>)
}

const initializeTargetStateCoverage = async ({
  now,
  runner,
}: InitializeTargetStateCoverageParams = {}): Promise<ProjectTransferTargetStateCoverageVersion> => {
  return withTransaction(runner, async (tx) => {
    const currentNow = getNow(now)

    await ensureGlobalUnknownToken(tx)
    await ensureTargetStateDirtyTokenRows(tx, projectTransferTargetStateSafetySurfaces)
    await tx.run(`
      INSERT INTO app.project_transfer_target_state_coverage (
        id,
        coverage_code_version,
        covered_surfaces_json,
        dependency_fingerprint_algorithm,
        dependency_fingerprint_code_version,
        initialized_at,
        updated_at
      ) VALUES (
        'current',
        ${getSqlLiteral(projectTransferTargetStateCoverageCodeVersion)},
        ${getJsonLiteral(projectTransferTargetStateSafetySurfaces)},
        ${getSqlLiteral(projectTransferDependencyFingerprintAlgorithm)},
        ${getSqlLiteral(projectTransferDependencyFingerprintCodeVersion)},
        ${getTimestampLiteral(currentNow)},
        ${getTimestampLiteral(currentNow)}
      )
      ON CONFLICT(id) DO UPDATE SET
        coverage_code_version = EXCLUDED.coverage_code_version,
        covered_surfaces_json = EXCLUDED.covered_surfaces_json,
        dependency_fingerprint_algorithm = EXCLUDED.dependency_fingerprint_algorithm,
        dependency_fingerprint_code_version = EXCLUDED.dependency_fingerprint_code_version,
        updated_at = EXCLUDED.updated_at
    `)

    return (await getTargetStateCoverageVersion(tx)) ?? Promise.reject(new Error('Target-state coverage init failed'))
  })
}

const getTargetStateDirtyTokenSnapshot = async ({
  runner: inputRunner,
}: GetTargetStateSnapshotParams = {}): Promise<ProjectTransferTargetStateDirtyTokenSnapshot> => {
  const runner = getRunner(inputRunner)
  const [coverage, globalUnknownToken, tokens] = await Promise.all([
    getTargetStateCoverageVersion(runner),
    getGlobalUnknownToken(runner),
    getTargetStateDirtyTokenRows(runner),
  ])

  return {capturedAt: new Date().toISOString(), coverage, globalUnknownToken, tokens}
}

const advanceTargetStateDirtyTokensAtomically = async ({
  now,
  reason,
  runner,
  surfaces,
}: AdvanceTargetStateDirtyTokensParams): Promise<ProjectTransferTargetStateDirtyTokenAdvance[]> => {
  assertValidSurfaces(surfaces)

  const uniqueSurfaces = getUniqueSurfaces(surfaces)

  return uniqueSurfaces.length === 0
    ? []
    : withTransaction(runner, async (tx) => {
        const currentNow = getNow(now)

        await ensureTargetStateDirtyTokenRows(tx, uniqueSurfaces)

        const rows = await tx.queryJson<DirtyTokenRow>(`
          UPDATE app.project_transfer_target_state_dirty_token
          SET
            dirty_token = dirty_token + 1,
            last_reason = ${getSqlLiteral(reason)},
            last_advanced_at = ${getTimestampLiteral(currentNow)},
            updated_at = ${getTimestampLiteral(currentNow)}
          WHERE surface IN (${getQuotedStringList(uniqueSurfaces).join(', ')})
          RETURNING surface, CAST(dirty_token AS INTEGER) AS dirtyToken
        `)

        return rows.map((row) => {
          return {dirtyToken: row.dirtyToken, surface: row.surface as ProjectTransferTargetStateSafetySurface}
        })
      })
}

const advanceGlobalUnknownTargetStateDirtyTokenAtomically = async ({
  now,
  reason,
  runner,
}: AdvanceGlobalUnknownTokenParams): Promise<number> => {
  return withTransaction(runner, async (tx) => {
    const currentNow = getNow(now)

    await ensureGlobalUnknownToken(tx)

    const [row] = await tx.queryJson<UnknownTokenRow>(`
      UPDATE app.project_transfer_target_state_unknown_token
      SET
        dirty_token = dirty_token + 1,
        last_reason = ${getSqlLiteral(reason)},
        last_advanced_at = ${getTimestampLiteral(currentNow)},
        updated_at = ${getTimestampLiteral(currentNow)}
      WHERE id = 'global'
      RETURNING CAST(dirty_token AS INTEGER) AS dirtyToken
    `)

    return row?.dirtyToken ?? Promise.reject(new Error('Target-state unknown token advance failed'))
  })
}

export const isProjectTransferTargetStateCoverageComplete = (
  snapshot: ProjectTransferTargetStateDirtyTokenSnapshot,
) => {
  const coverage = snapshot.coverage

  return (
    coverage !== null
    && projectTransferTargetStateSafetySurfaces.every((surface) => {
      return coverage.coveredSurfaces.includes(surface)
    })
  )
}

const projectTransferTargetStateDirtyTokenService = {
  advanceGlobalUnknownTargetStateDirtyTokenAtomically,
  advanceTargetStateDirtyTokensAtomically,
  getTargetStateDirtyTokenSnapshot,
  initializeTargetStateCoverage,
}

export const getProjectTransferTargetStateDirtyTokenService = () => {
  return projectTransferTargetStateDirtyTokenService
}

export type {TargetStateDirtyTokenRunner}
