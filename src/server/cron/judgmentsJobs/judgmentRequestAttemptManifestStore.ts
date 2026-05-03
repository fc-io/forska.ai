import {
  mutateAcceptedClaimRequestAttemptManifest,
  shouldUseJudgeWorkerOwnerHandoff,
} from './judgeWorkerCompletionJournal.ts'
import {getJudgmentJobSqliteService} from './judgmentJobSqliteService.ts'
import {
  type JudgmentRequestAttemptCloseoutKind,
  type JudgmentRequestAttemptJsonEntry,
  type JudgmentRequestAttemptManifestMutation,
  type JudgmentRequestAttemptManifestOwner,
  type JudgmentRequestAttemptRuntimeContext,
  withRequestAttemptManifestStage,
} from './judgmentRequestAttemptManifest.ts'

type RequestAttemptStageInput = {
  baseURL?: string | null
  closeoutKind: JudgmentRequestAttemptCloseoutKind
  error?: string | null
  errorCode?: string | null
  finishedAt?: string | null
  outcome?: JudgmentRequestAttemptJsonEntry['outcome']
  owner?: JudgmentRequestAttemptManifestOwner | null
  providerDiagnostics?: unknown
  requestAttempt: JudgmentRequestAttemptRuntimeContext
  startedAt?: string | null
}

const getOwnerKey = (owner: JudgmentRequestAttemptManifestOwner): string => {
  return owner.kind === 'accepted_claim' ? `claim:${owner.claimId}` : `prompt:${owner.jobId}:${owner.queueRecordId}`
}

const mutateOwnerManifest = async (
  owner: JudgmentRequestAttemptManifestOwner,
  mutation: JudgmentRequestAttemptManifestMutation,
): Promise<void> => {
  return owner.kind === 'accepted_claim'
    ? mutateAcceptedClaimRequestAttemptManifest({mutation, owner})
    : getJudgmentJobSqliteService().mutateRequestAttemptManifest(owner, mutation)
}

const getPromptId = (owner: JudgmentRequestAttemptManifestOwner): string | null => {
  return owner.promptId ?? owner.promptIds?.[0] ?? null
}

const getManifestEntryForStage = ({
  baseURL,
  closeoutKind,
  error,
  errorCode,
  finishedAt,
  outcome = 'unknown',
  owner,
  providerDiagnostics,
  requestAttempt,
  startedAt,
}: RequestAttemptStageInput & {owner: JudgmentRequestAttemptManifestOwner}): JudgmentRequestAttemptJsonEntry => {
  return {
    articleId: owner.articleId ?? null,
    baseURL: baseURL ?? null,
    claimId: owner.claimId ?? null,
    closeoutKind,
    durableCloseoutRef: null,
    error: error ?? null,
    errorCode: errorCode ?? null,
    finishedAt: finishedAt ?? null,
    jobId: owner.jobId,
    outcome,
    promptId: getPromptId(owner),
    promptIds: owner.promptIds,
    providerDiagnostics: providerDiagnostics ?? null,
    providerKey: requestAttempt.providerKey,
    queueRecordId: owner.queueRecordId,
    requestAttemptId: requestAttempt.requestAttemptId,
    startedAt: startedAt ?? requestAttempt.createdAt,
  }
}

export const getRequestAttemptManifestOwner = ({
  articleId,
  claimId,
  jobId,
  promptId,
  promptIds,
  queueRecordId,
}: {
  articleId?: string | null
  claimId?: string | null
  jobId: string
  promptId?: string | null
  promptIds?: string[]
  queueRecordId: string
}): JudgmentRequestAttemptManifestOwner => {
  return shouldUseJudgeWorkerOwnerHandoff() && claimId
    ? {articleId, claimId, jobId, kind: 'accepted_claim', promptId, promptIds, queueRecordId}
    : {articleId, claimId, jobId, kind: 'queue_prompt', promptId, promptIds, queueRecordId}
}

export const recordRequestAttemptManifestStage = async ({owner, ...input}: RequestAttemptStageInput): Promise<void> => {
  return owner ? mutateOwnerManifest(owner, {mergeEntries: [getManifestEntryForStage({...input, owner})]}) : undefined
}

const getManifestOwnerFromAttempt = (
  attempt: JudgmentRequestAttemptJsonEntry,
): JudgmentRequestAttemptManifestOwner | null => {
  if (!attempt.jobId || !attempt.queueRecordId) {
    return null
  }

  return getRequestAttemptManifestOwner({
    articleId: attempt.articleId,
    claimId: attempt.claimId,
    jobId: attempt.jobId,
    promptId: attempt.promptId,
    promptIds: attempt.promptIds,
    queueRecordId: attempt.queueRecordId,
  })
}

const groupRequestAttemptsByManifestOwner = (
  requestAttempts: JudgmentRequestAttemptJsonEntry[],
): Array<{entries: JudgmentRequestAttemptJsonEntry[]; owner: JudgmentRequestAttemptManifestOwner}> => {
  const grouped = requestAttempts.reduce((map, entry) => {
    const owner = getManifestOwnerFromAttempt(entry)

    if (!owner) {
      return map
    }

    const key = getOwnerKey(owner)
    const current = map.get(key)
    map.set(key, {entries: [...(current?.entries ?? []), entry], owner})

    return map
  }, new Map<string, {entries: JudgmentRequestAttemptJsonEntry[]; owner: JudgmentRequestAttemptManifestOwner}>())

  return Array.from(grouped.values())
}

export const recordRequestAttemptsEnteringPersistence = async (
  requestAttempts: JudgmentRequestAttemptJsonEntry[],
): Promise<void> => {
  await Promise.all(
    groupRequestAttemptsByManifestOwner(
      withRequestAttemptManifestStage({closeoutKind: 'persistence', requestAttempts}),
    ).map(({entries, owner}) => {
      return mutateOwnerManifest(owner, {mergeEntries: entries})
    }),
  )
}

export const compactClosedOutRequestAttemptManifestEntries = async (
  requestAttempts: JudgmentRequestAttemptJsonEntry[],
): Promise<void> => {
  await Promise.all(
    groupRequestAttemptsByManifestOwner(requestAttempts).map(({entries, owner}) => {
      return mutateOwnerManifest(owner, {
        compactRequestAttemptIds: entries.map((entry) => {
          return entry.requestAttemptId
        }),
        mergeEntries: entries,
      })
    }),
  )
}
