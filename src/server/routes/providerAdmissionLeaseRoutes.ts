import {Elysia, t} from 'elysia'

import {
  acquireProviderAdmissionLeaseOnCurrentOwner,
  expireProviderAdmissionLeasesOnCurrentOwner,
  heartbeatProviderAdmissionLeaseOnCurrentOwner,
  providerAdmissionLeaseOwnerApiAliasPath,
  providerAdmissionLeaseOwnerApiPath,
  reconcileProviderAdmissionLeasesOnCurrentOwner,
  releaseProviderAdmissionLeaseOnCurrentOwner,
  releaseProviderAdmissionLeaseWithResultOnCurrentOwner,
} from '../cron/judgmentsJobs/providerAdmissionLease.ts'
import {withErrorHandler} from '../utils/routeErrorHandler.ts'

const providerBucketSnapshotBody = t.Object({
  maxInflightRequests: t.Union([t.Number(), t.Null()]),
  providerFamily: t.String(),
  providerId: t.String(),
  providerKey: t.String(),
  providerLimit: t.Number(),
  providerLimitVersion: t.String(),
  providerName: t.String(),
  providerUsesFamilyDefault: t.Boolean(),
  resolvedDefaultCapacity: t.Number(),
})

const providerAdmissionLeaseAcquireBody = t.Object({
  endpointAvailabilityKey: t.Optional(t.Union([t.String(), t.Null()])),
  holderToken: t.String(),
  leaseIdentity: t.String(),
  leaseKind: t.Optional(t.Union([t.Literal('probe'), t.Literal('request')])),
  nowMs: t.Optional(t.Number()),
  probeAttemptId: t.Optional(t.Union([t.String(), t.Null()])),
  requestAttemptId: t.Optional(t.Union([t.String(), t.Null()])),
  snapshot: providerBucketSnapshotBody,
  ttlMs: t.Optional(t.Number()),
})

const providerAdmissionLeaseReleaseBody = t.Object({
  holderToken: t.String(),
  leaseIdentity: t.String(),
  providerKey: t.String(),
})

const providerAdmissionLeaseHeartbeatBody = t.Composite([
  providerAdmissionLeaseReleaseBody,
  t.Object({nowMs: t.Optional(t.Number()), ttlMs: t.Optional(t.Number())}),
])

const providerAdmissionLeaseExpiryBody = t.Object({nowMs: t.Optional(t.Number()), providerKey: t.String()})

const providerAdmissionLeaseHolderWorkerDemotionBody = t.Object({
  demotedAtMs: t.Optional(t.Union([t.Number(), t.Null()])),
  freshness: t.Optional(t.Union([t.Literal('demoted'), t.Literal('fresh'), t.Literal('missing'), t.Literal('stale')])),
  holderToken: t.String(),
  missingSinceMs: t.Optional(t.Union([t.Number(), t.Null()])),
  observedAtMs: t.Optional(t.Union([t.Number(), t.Null()])),
  staleSinceMs: t.Optional(t.Union([t.Number(), t.Null()])),
  state: t.Optional(t.Union([t.Literal('demoted'), t.Literal('fresh'), t.Literal('missing'), t.Literal('stale')])),
})

const providerAdmissionLeaseTerminalRequestCloseoutBody = t.Object({
  providerKey: t.Optional(t.Union([t.String(), t.Null()])),
  requestAttemptId: t.String(),
})

const providerAdmissionLeaseSuspectFreshProofBody = t.Object({
  holderToken: t.Optional(t.Union([t.String(), t.Null()])),
  leaseIdentity: t.String(),
  leaseKind: t.Optional(t.Union([t.Literal('probe'), t.Literal('request'), t.Null()])),
  providerKey: t.String(),
})

const providerAdmissionLeaseReconciliationBody = t.Object({
  holderGraceMs: t.Optional(t.Number()),
  holderWorkerDemotions: t.Optional(t.Array(providerAdmissionLeaseHolderWorkerDemotionBody)),
  nowMs: t.Optional(t.Number()),
  suspectFreshHolderProofs: t.Optional(t.Array(providerAdmissionLeaseSuspectFreshProofBody)),
  suspectFreshProofs: t.Optional(t.Array(providerAdmissionLeaseSuspectFreshProofBody)),
  terminalRequestAttemptCloseouts: t.Optional(t.Array(providerAdmissionLeaseTerminalRequestCloseoutBody)),
})

const addProviderAdmissionLeaseRoutes = (app: Elysia, prefix: string) => {
  return app
    .post(
      `${prefix}/acquire`,
      async ({body}) => {
        return {data: await acquireProviderAdmissionLeaseOnCurrentOwner(body)}
      },
      {body: providerAdmissionLeaseAcquireBody},
    )
    .post(
      `${prefix}/heartbeat`,
      async ({body}) => {
        return {data: await heartbeatProviderAdmissionLeaseOnCurrentOwner(body)}
      },
      {body: providerAdmissionLeaseHeartbeatBody},
    )
    .post(
      `${prefix}/release`,
      async ({body}) => {
        return {data: await releaseProviderAdmissionLeaseOnCurrentOwner(body)}
      },
      {body: providerAdmissionLeaseReleaseBody},
    )
    .post(
      `${prefix}/release-result`,
      async ({body}) => {
        return {data: await releaseProviderAdmissionLeaseWithResultOnCurrentOwner(body)}
      },
      {body: providerAdmissionLeaseReleaseBody},
    )
    .post(
      `${prefix}/expire`,
      async ({body}) => {
        return {data: await expireProviderAdmissionLeasesOnCurrentOwner(body)}
      },
      {body: providerAdmissionLeaseExpiryBody},
    )
    .post(
      `${prefix}/reconcile`,
      async ({body}) => {
        return {data: await reconcileProviderAdmissionLeasesOnCurrentOwner(body)}
      },
      {body: providerAdmissionLeaseReconciliationBody},
    )
}

export const providerAdmissionLeaseRoutes = addProviderAdmissionLeaseRoutes(
  addProviderAdmissionLeaseRoutes(new Elysia().use(withErrorHandler()), providerAdmissionLeaseOwnerApiPath),
  providerAdmissionLeaseOwnerApiAliasPath,
)
