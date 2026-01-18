type JobCursor = {lastDate: Date; lastArticleId: string}

const cursors = new Map<string, JobCursor>()

export const getJobCursor = (jobId: string): JobCursor | null => {
  return cursors.get(jobId) ?? null
}

export const setJobCursor = (jobId: string, cursor: JobCursor): void => {
  cursors.set(jobId, cursor)
}

export const clearJobCursor = (jobId: string): void => {
  cursors.delete(jobId)
}

export const clearAllJobCursors = (): void => {
  cursors.clear()
}
