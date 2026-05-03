import {Elysia, t} from 'elysia'

import {
  getLocalJudgmentDispatchTelemetry,
  judgmentDispatchTelemetryPath,
} from '../cron/judgmentsJobs/judgmentDispatchTelemetry.ts'

const judgmentDispatchTelemetryQuerySchema = t.Object({
  modelId: t.Optional(t.String()),
  modelProvider: t.Optional(t.String()),
  providerConnectionId: t.Optional(t.String()),
  providerMaxInflightRequests: t.Optional(t.String()),
  providerUsesFamilyDefault: t.Optional(t.String()),
})

const getNullableNumberQueryValue = (value: string | undefined): number | null => {
  const parsed = Number(value)

  return value === undefined || value.trim() === '' || !Number.isFinite(parsed) ? null : parsed
}

const getBooleanQueryValue = (value: string | undefined): boolean => {
  return value === 'true'
}

export const judgmentDispatchTelemetryRoutes = new Elysia().get(
  `${judgmentDispatchTelemetryPath}/:jobId`,
  async ({params, query}) => {
    return {
      data: await getLocalJudgmentDispatchTelemetry({
        jobId: params.jobId,
        modelId: query.modelId ?? null,
        modelProvider: query.modelProvider ?? null,
        providerConnectionId: query.providerConnectionId ?? null,
        providerMaxInflightRequests: getNullableNumberQueryValue(query.providerMaxInflightRequests),
        providerUsesFamilyDefault: getBooleanQueryValue(query.providerUsesFamilyDefault),
      }),
      error: null,
    }
  },
  {params: t.Object({jobId: t.String()}), query: judgmentDispatchTelemetryQuerySchema},
)
