import {Elysia, t} from 'elysia'

import {
  getLocalJudgmentDispatchTelemetry,
  judgmentDispatchTelemetryInternalPath,
  judgmentDispatchTelemetryPath,
} from '../cron/judgmentsJobs/judgmentDispatchTelemetry.ts'

const judgmentDispatchTelemetryQuerySchema = t.Object({
  modelId: t.Optional(t.String()),
  modelProvider: t.Optional(t.String()),
  providerFamily: t.Optional(t.String()),
  providerConnectionId: t.Optional(t.String()),
  providerId: t.Optional(t.String()),
  providerKey: t.Optional(t.String()),
  providerLimit: t.Optional(t.String()),
  providerLimitVersion: t.Optional(t.String()),
  providerMaxInflightRequests: t.Optional(t.String()),
  providerName: t.Optional(t.String()),
  providerUsesFamilyDefault: t.Optional(t.String()),
  readyCount: t.Optional(t.String()),
  resolvedDefaultCapacity: t.Optional(t.String()),
})

const getNullableNumberQueryValue = (value: string | undefined): number | null => {
  const parsed = Number(value)

  return value === undefined || value.trim() === '' || !Number.isFinite(parsed) ? null : parsed
}

const getBooleanQueryValue = (value: string | undefined): boolean => {
  return value === 'true'
}

type JudgmentDispatchTelemetryRouteQuery = typeof judgmentDispatchTelemetryQuerySchema.static

const getJudgmentDispatchTelemetryRouteResponse = async ({
  jobId,
  query,
}: {
  jobId: string
  query: JudgmentDispatchTelemetryRouteQuery
}) => {
  return {
    data: await getLocalJudgmentDispatchTelemetry({
      jobId,
      modelId: query.modelId ?? null,
      modelProvider: query.modelProvider ?? null,
      providerFamily: query.providerFamily ?? null,
      providerConnectionId: query.providerConnectionId ?? null,
      providerId: query.providerId ?? null,
      providerKey: query.providerKey ?? null,
      providerLimit: getNullableNumberQueryValue(query.providerLimit),
      providerLimitVersion: query.providerLimitVersion ?? null,
      providerMaxInflightRequests: getNullableNumberQueryValue(query.providerMaxInflightRequests),
      providerName: query.providerName ?? null,
      providerUsesFamilyDefault: getBooleanQueryValue(query.providerUsesFamilyDefault),
      readyCount: getNullableNumberQueryValue(query.readyCount),
      resolvedDefaultCapacity: getNullableNumberQueryValue(query.resolvedDefaultCapacity),
    }),
    error: null,
  }
}

const getJudgmentDispatchTelemetryHandler = async ({
  params,
  query,
}: {
  params: {jobId: string}
  query: JudgmentDispatchTelemetryRouteQuery
}) => {
  return getJudgmentDispatchTelemetryRouteResponse({jobId: params.jobId, query})
}

export const judgmentDispatchTelemetryRoutes = new Elysia()
  .get(`${judgmentDispatchTelemetryPath}/:jobId`, getJudgmentDispatchTelemetryHandler, {
    params: t.Object({jobId: t.String()}),
    query: judgmentDispatchTelemetryQuerySchema,
  })
  .get(`${judgmentDispatchTelemetryInternalPath}/:jobId`, getJudgmentDispatchTelemetryHandler, {
    params: t.Object({jobId: t.String()}),
    query: judgmentDispatchTelemetryQuerySchema,
  })
