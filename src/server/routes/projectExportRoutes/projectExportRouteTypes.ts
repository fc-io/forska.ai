export type PromptDetails = {id: string; promptHeading: string | null; originalText: string | null; type: string | null}

export type ExportJobRow = {
  criteriaJson: unknown
  latestSnapshotSemantics: boolean
  resultManifestJson: unknown
  reviewConfigHash: string | null
  snapshotId: string | null
  status: string
}
