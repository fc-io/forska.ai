export type OrphanPromptSummary = {
  id: string
  promptHeading: string | null
  originalText: string | null
  type: string | null
  createdAt: string | Date
  usage: {projects: number; judgments: number; humanJudgments: number}
}

export type OrphansResponse = {
  noProjects: OrphanPromptSummary[]
  noJudgments: OrphanPromptSummary[]
  noProjectsAndJudgments: OrphanPromptSummary[]
}

const emptyOrphansResponse: OrphansResponse = {noProjects: [], noJudgments: [], noProjectsAndJudgments: []}

export const parseOrphansResponse = (
  data: unknown,
  toPromptSummary: (value: unknown) => OrphanPromptSummary | null,
): OrphansResponse => {
  const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : null
  const readList = (value: unknown): OrphanPromptSummary[] => {
    return Array.isArray(value)
      ? value.map(toPromptSummary).filter((prompt): prompt is OrphanPromptSummary => {
          return prompt !== null
        })
      : []
  }

  return record
    ? {
        noProjects: readList(record.noProjects),
        noJudgments: readList(record.noJudgments),
        noProjectsAndJudgments: readList(record.noProjectsAndJudgments),
      }
    : emptyOrphansResponse
}
