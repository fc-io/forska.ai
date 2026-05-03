import {Elysia, t} from 'elysia'

import {
  acquireProviderAdmissionLeaseOnCurrentOwner,
  expireProviderAdmissionLeasesOnCurrentOwner,
  heartbeatProviderAdmissionLeaseOnCurrentOwner,
  providerAdmissionLeaseOwnerApiAliasPath,
  providerAdmissionLeaseOwnerApiPath,
  releaseProviderAdmissionLeaseOnCurrentOwner,
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
      `${prefix}/expire`,
      async ({body}) => {
        return {data: await expireProviderAdmissionLeasesOnCurrentOwner(body)}
      },
      {body: providerAdmissionLeaseExpiryBody},
    )
}

export const providerAdmissionLeaseRoutes = addProviderAdmissionLeaseRoutes(
  addProviderAdmissionLeaseRoutes(new Elysia().use(withErrorHandler()), providerAdmissionLeaseOwnerApiPath),
  providerAdmissionLeaseOwnerApiAliasPath,
)
