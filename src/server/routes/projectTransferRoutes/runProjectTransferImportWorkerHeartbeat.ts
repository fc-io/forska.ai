import {getProjectTransferSessionRepository} from '../../services/projectTransfer/projectTransferSessionRepository.ts'

const importWorkerHeartbeatIntervalMs = 15_000
const importWorkerHeartbeatLeaseMs = 60_000

const refreshProjectTransferImportWorkerHeartbeat = async ({
  ownerToken,
  sessionId,
}: {
  ownerToken: string
  sessionId: string
}) => {
  const heartbeat = await getProjectTransferSessionRepository().heartbeatProjectTransferSessionOwner({
    leaseMs: importWorkerHeartbeatLeaseMs,
    ownerToken,
    sessionId,
  })

  if (heartbeat === null) {
    throw new Error(`Project transfer import session ownership was lost: ${sessionId}`)
  }

  return heartbeat
}

export const runProjectTransferImportWorkerHeartbeat = async <TValue>({
  operation,
  ownerToken,
  sessionId,
}: {
  operation: () => Promise<TValue>
  ownerToken: string
  sessionId: string
}) => {
  const interval = setInterval(() => {
    void refreshProjectTransferImportWorkerHeartbeat({ownerToken, sessionId}).catch((error) => {
      console.error('Project transfer import worker heartbeat failed', error)
    })
  }, importWorkerHeartbeatIntervalMs)

  return operation().finally(() => {
    clearInterval(interval)
  })
}
