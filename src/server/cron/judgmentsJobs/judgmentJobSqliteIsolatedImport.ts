import {
  type JudgmentJobSqliteOutboxImportCycleResult,
  runJudgmentJobSqliteOutboxImportCycleForClaimedBatch,
} from './judgmentJobSqliteOutboxImport.ts'
import type {JudgmentJobSqliteClaimedOutboxBatch, JudgmentJobSqliteOutboxEntry} from './judgmentJobSqliteService.ts'

const isolatedImportFlushMaxCycles = 1_000

type ParsedIsolatedImportOutput = Partial<JudgmentJobSqliteOutboxImportCycleResult> & {
  claimedBatch?: unknown
  cycleStatus?: unknown
  error?: unknown
  jobId?: unknown
  status?: unknown
}

export type JudgmentJobSqliteIsolatedImportProcessResult = {
  errorMessage: string | null
  exitCode: number
  result: JudgmentJobSqliteOutboxImportCycleResult | null
}

export type JudgmentJobSqliteIsolatedFlushResult = {
  cycleCount: number
  errorMessage: string | null
  exitCode: number
  importedCount: number
  lastResult: JudgmentJobSqliteOutboxImportCycleResult | null
}

const getLastJsonLine = (output: string) => {
  const lines = output
    .split('\n')
    .map((line) => {
      return line.trim()
    })
    .filter((line) => {
      return line.startsWith('{') && line.endsWith('}')
    })

  const [lastLine = ''] = lines.slice(-1)

  return lastLine === '' ? null : lastLine
}

const parseIsolatedImportOutput = (stdout: string) => {
  const lastJsonLine = getLastJsonLine(stdout)

  return lastJsonLine
    ? (() => {
        try {
          return JSON.parse(lastJsonLine) as ParsedIsolatedImportOutput
        } catch (_error) {
          return null
        }
      })()
    : null
}

const normalizeClaimedBatch = (value: unknown): JudgmentJobSqliteClaimedOutboxBatch | null => {
  if (typeof value !== 'object' || value === null || !('claim' in value) || !('rows' in value)) {
    return null
  }

  const claim = value.claim as {claimId?: unknown; jobId?: unknown; rowCount?: unknown}
  const rows = value.rows

  if (
    typeof claim !== 'object'
    || claim === null
    || typeof claim.claimId !== 'string'
    || typeof claim.jobId !== 'string'
    || typeof claim.rowCount !== 'number'
    || !Array.isArray(rows)
  ) {
    return null
  }

  return {
    claim: {claimId: claim.claimId, jobId: claim.jobId, rowCount: claim.rowCount},
    rows: rows.map((row) => {
      const normalizedRow = row as JudgmentJobSqliteOutboxEntry & {createdAt: string; updatedAt: string}

      return {
        ...normalizedRow,
        createdAt: new Date(normalizedRow.createdAt),
        updatedAt: new Date(normalizedRow.updatedAt),
      }
    }),
  }
}

const getCycleResult = (parsed: ParsedIsolatedImportOutput | null): JudgmentJobSqliteOutboxImportCycleResult | null => {
  if (!parsed) {
    return null
  }

  const cycleStatus = parsed.cycleStatus === 'idle' || parsed.cycleStatus === 'imported' ? parsed.cycleStatus : null
  const status = parsed.status === 'idle' || parsed.status === 'imported' ? parsed.status : null
  const normalizedStatus = cycleStatus ?? status

  return normalizedStatus === null
    ? null
    : {
        claimedBy: typeof parsed.claimedBy === 'string' ? parsed.claimedBy : '',
        discardedCount: Number(parsed.discardedCount ?? 0),
        duplicateCount: Number(parsed.duplicateCount ?? 0),
        importedCount: Number(parsed.importedCount ?? 0),
        jobId: typeof parsed.jobId === 'string' ? parsed.jobId : null,
        outboxClaimId: typeof parsed.outboxClaimId === 'string' ? parsed.outboxClaimId : null,
        outboxRowCount: Number(parsed.outboxRowCount ?? 0),
        status: normalizedStatus,
      }
}

const getIsolatedImportErrorMessage = ({
  exitCode,
  stderr,
  stdout,
}: {
  exitCode: number
  stderr: string
  stdout: string
}) => {
  const parsed = parseIsolatedImportOutput(stdout)

  if (typeof parsed?.error === 'string' && parsed.error.trim() !== '') {
    return parsed.error.trim()
  }

  const trimmedStderr = stderr.trim()
  const trimmedStdout = stdout.trim()

  return trimmedStderr || trimmedStdout || `SQLite importer exited with code ${exitCode}`
}

export const isJudgmentJobSqliteIsolatedImportLeaseConflict = (errorMessage: string) => {
  return errorMessage.includes('SQLite job lease')
}

export const runJudgmentJobSqliteIsolatedImportCycle = async ({
  claimedBy,
  jobId,
}: {
  claimedBy: string
  jobId: string
}): Promise<JudgmentJobSqliteIsolatedImportProcessResult> => {
  const childProcess = globalThis.Bun.spawn(
    ['bun', 'scripts/runJudgmentJobSqliteSingleJobClaimExport.ts', `--jobId=${jobId}`, `--claimedBy=${claimedBy}`],
    {cwd: process.cwd(), env: {...process.env}, stderr: 'pipe', stdout: 'pipe'},
  )
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(childProcess.stdout).text(),
    new Response(childProcess.stderr).text(),
    childProcess.exited,
  ])
  const parsed = parseIsolatedImportOutput(stdout)
  const parsedStatus = parsed ? (parsed as {status?: unknown}).status : undefined
  const result = getCycleResult(parsed)
  const claimedBatch = normalizeClaimedBatch(parsed?.claimedBatch)

  if (exitCode === 0 && result !== null) {
    return {errorMessage: null, exitCode, result}
  }

  if (exitCode === 0 && parsedStatus === 'claimed' && claimedBatch !== null) {
    try {
      const importedResult = await runJudgmentJobSqliteOutboxImportCycleForClaimedBatch({
        claimedBatch,
        claimedBy,
        requestedJobId: jobId,
      })

      return {errorMessage: null, exitCode, result: importedResult}
    } catch (error) {
      return {errorMessage: error instanceof Error ? error.message : String(error), exitCode: 1, result: null}
    }
  }

  if (exitCode === 0) {
    return {errorMessage: 'SQLite importer did not return a parseable cycle result', exitCode, result: null}
  }

  return {errorMessage: getIsolatedImportErrorMessage({exitCode, stderr, stdout}), exitCode, result}
}

export const runJudgmentJobSqliteIsolatedFlush = async ({
  claimedBy,
  cycleCount = 0,
  jobId,
  lastResult = null,
  totalImported = 0,
}: {
  claimedBy: string
  cycleCount?: number
  jobId: string
  lastResult?: JudgmentJobSqliteOutboxImportCycleResult | null
  totalImported?: number
}): Promise<JudgmentJobSqliteIsolatedFlushResult> => {
  if (cycleCount >= isolatedImportFlushMaxCycles) {
    return {
      cycleCount,
      errorMessage: `SQLite isolated flush exceeded ${isolatedImportFlushMaxCycles} cycles for ${jobId}`,
      exitCode: 1,
      importedCount: totalImported,
      lastResult,
    }
  }

  const result = await runJudgmentJobSqliteIsolatedImportCycle({claimedBy, jobId})
  const cycleResult = result.result

  return result.errorMessage !== null
    ? {
        cycleCount: cycleCount + 1,
        errorMessage: result.errorMessage,
        exitCode: result.exitCode,
        importedCount: totalImported,
        lastResult: cycleResult,
      }
    : cycleResult?.importedCount === 0
      ? {
          cycleCount: cycleCount + 1,
          errorMessage: null,
          exitCode: result.exitCode,
          importedCount: totalImported,
          lastResult: cycleResult,
        }
      : runJudgmentJobSqliteIsolatedFlush({
          claimedBy,
          cycleCount: cycleCount + 1,
          jobId,
          lastResult: cycleResult,
          totalImported: totalImported + (cycleResult?.importedCount ?? 0),
        })
}
