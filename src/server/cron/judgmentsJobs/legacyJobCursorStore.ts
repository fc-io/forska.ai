import type {JobCursor} from './judgmentJobSqliteService.ts'

const legacyJobCursors = new Map<string, JobCursor>()

const deleteLegacyJobCursors = (jobIds: string[]): void => {
  const [currentJobId = ''] = jobIds

  if (!currentJobId) {
    return
  }

  legacyJobCursors.delete(currentJobId)
  return deleteLegacyJobCursors(jobIds.slice(1))
}

export const getLegacyJobCursor = async (jobId: string): Promise<JobCursor | null> => {
  return legacyJobCursors.get(jobId) ?? null
}

export const setLegacyJobCursor = async (jobId: string, cursor: JobCursor): Promise<void> => {
  legacyJobCursors.set(jobId, cursor)
}

export const clearLegacyJobCursor = async (jobId: string): Promise<void> => {
  legacyJobCursors.delete(jobId)
}

export const syncLegacyJobCursors = async (jobIds: string[]): Promise<void> => {
  const activeJobIds = new Set(jobIds)

  return deleteLegacyJobCursors(
    Array.from(legacyJobCursors.keys()).filter((jobId) => {
      return !activeJobIds.has(jobId)
    }),
  )
}

export const clearAllLegacyJobCursors = async (): Promise<void> => {
  return deleteLegacyJobCursors(Array.from(legacyJobCursors.keys()))
}
