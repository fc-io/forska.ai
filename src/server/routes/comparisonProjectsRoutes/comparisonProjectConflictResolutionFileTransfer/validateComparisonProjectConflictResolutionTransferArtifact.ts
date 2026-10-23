import {getNormalizedComparisonProjectConflictComment} from '../../../../utils/comparisonProjectConflictResolutionComment.ts'
import {
  type ComparisonProjectConflictResolutionTransferArtifact,
  comparisonProjectConflictResolutionTransferArtifactSchema,
} from './comparisonProjectConflictResolutionTransferArtifactSchema.ts'

const transferArtifactRootKeys = ['exportedAt', 'format', 'judgmentContexts', 'rows', 'source', 'version']

const getUnexpectedRootKeys = (artifact: unknown) => {
  return artifact && typeof artifact === 'object' && !Array.isArray(artifact)
    ? Object.keys(artifact).filter((key) => {
        return !transferArtifactRootKeys.includes(key)
      })
    : []
}

const assertNoUnexpectedRootKeys = (artifact: unknown) => {
  const unexpectedKeys = getUnexpectedRootKeys(artifact)

  if (unexpectedKeys.length > 0) {
    throw new Error(`Unexpected conflict resolution transfer artifact root fields: ${unexpectedKeys.join(', ')}`)
  }
}

export const comparisonProjectConflictResolutionTransferJudgmentContextMaxBytes = 64 * 1024

const assertJudgmentContextsWithinSizeLimit = (artifact: ComparisonProjectConflictResolutionTransferArtifact) => {
  const oversizedContext = (artifact.judgmentContexts ?? []).find((entry) => {
    return (
      Buffer.byteLength(JSON.stringify(entry.context), 'utf8')
      > comparisonProjectConflictResolutionTransferJudgmentContextMaxBytes
    )
  })

  if (oversizedContext) {
    throw new Error(
      `Conflict resolution transfer judgment context ${oversizedContext.id.slice(0, 64)} exceeds ${comparisonProjectConflictResolutionTransferJudgmentContextMaxBytes} bytes`,
    )
  }

  return artifact
}

const getIsCommentOnlyTransferRowValid = (
  artifact: ComparisonProjectConflictResolutionTransferArtifact,
  row: ComparisonProjectConflictResolutionTransferArtifact['rows'][number],
) => {
  return (
    row.resolution !== null
    || (artifact.version >= 3 && getNormalizedComparisonProjectConflictComment(row.comment) !== null)
  )
}

const assertCommentOnlyRowsAllowed = (artifact: ComparisonProjectConflictResolutionTransferArtifact) => {
  const invalidRowIndex = artifact.rows.findIndex((row) => {
    return !getIsCommentOnlyTransferRowValid(artifact, row)
  })

  if (invalidRowIndex >= 0) {
    throw new Error(
      `Conflict resolution transfer row ${invalidRowIndex + 1} has no resolution; only version 3 rows with a comment may omit it`,
    )
  }

  return artifact
}

export const validateComparisonProjectConflictResolutionTransferArtifact = (
  artifact: unknown,
): ComparisonProjectConflictResolutionTransferArtifact => {
  assertNoUnexpectedRootKeys(artifact)

  return assertCommentOnlyRowsAllowed(
    assertJudgmentContextsWithinSizeLimit(comparisonProjectConflictResolutionTransferArtifactSchema.assert(artifact)),
  )
}
