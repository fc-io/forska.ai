import {Elysia, t} from 'elysia'

import {getUserConfigQueryService} from '../services/userConfigQueryService.ts'
import {type ProjectMartLargeRebuildTuningMode} from '../utils/localAppSettings.ts'
import {readLocalAppSettings, updateLocalAppSettings} from '../utils/localAppSettings.ts'
import {withErrorHandler} from '../utils/routeErrorHandler'

const getNullableString = (value: string | null): string | null => {
  const normalized = String(value ?? '').trim()

  return normalized === '' ? null : normalized
}

const getNullablePositiveInteger = (value: number | null): number | null => {
  return Number.isInteger(value) && value > 0 ? value : null
}

const getProjectMartLargeRebuildTuningMode = (
  value: ProjectMartLargeRebuildTuningMode | null,
): ProjectMartLargeRebuildTuningMode => {
  return value === 'manual' ? 'manual' : 'automatic'
}

const getLocalUserSettings = async () => {
  const userConfig = await getUserConfigQueryService().getOrCreateUserConfig()
  const localAppSettings = readLocalAppSettings()

  return {...userConfig, codexBin: localAppSettings.codexBin, duckdbBin: localAppSettings.duckdbBin}
}

export const usersRoutes = new Elysia()
  .use(withErrorHandler())
  .get('/api/users', async () => {
    return {data: [await getLocalUserSettings()]}
  })
  .patch(
    '/api/users',
    async ({body}) => {
      const localAppSettings = updateLocalAppSettings({
        maintenanceWorkerDuckdbMemoryLimit: getNullableString(body.maintenanceWorkerDuckdbMemoryLimit),
        codexBin: getNullableString(body.codexBin),
        duckdbBin: getNullableString(body.duckdbBin),
        projectMartLargeRebuildBatchSize: getNullablePositiveInteger(body.projectMartLargeRebuildBatchSize),
        projectMartLargeRebuildMaxCyclesPerWake: getNullablePositiveInteger(
          body.projectMartLargeRebuildMaxCyclesPerWake,
        ),
        projectMartLargeRebuildPollIntervalMs: getNullablePositiveInteger(body.projectMartLargeRebuildPollIntervalMs),
        projectMartLargeRebuildTuningMode: getProjectMartLargeRebuildTuningMode(body.projectMartLargeRebuildTuningMode),
      })
      const userConfig = await getUserConfigQueryService().updateUserConfig({
        maintenanceWorkerDuckdbMemoryLimit: getNullableString(body.maintenanceWorkerDuckdbMemoryLimit),
        email: body.email,
        fullTextConversionModelId: getNullableString(body.fullTextConversionModelId),
        name: body.name,
        projectMartLargeRebuildBatchSize: getNullablePositiveInteger(body.projectMartLargeRebuildBatchSize),
        projectMartLargeRebuildMaxCyclesPerWake: getNullablePositiveInteger(
          body.projectMartLargeRebuildMaxCyclesPerWake,
        ),
        projectMartLargeRebuildPollIntervalMs: getNullablePositiveInteger(body.projectMartLargeRebuildPollIntervalMs),
        projectMartLargeRebuildTuningMode: getProjectMartLargeRebuildTuningMode(body.projectMartLargeRebuildTuningMode),
        unpaywallEmail: getNullableString(body.unpaywallEmail),
      })

      return {data: {...userConfig, codexBin: localAppSettings.codexBin, duckdbBin: localAppSettings.duckdbBin}}
    },
    {
      body: t.Object({
        maintenanceWorkerDuckdbMemoryLimit: t.Union([t.String(), t.Null()]),
        codexBin: t.Union([t.String(), t.Null()]),
        duckdbBin: t.Union([t.String(), t.Null()]),
        email: t.String(),
        fullTextConversionModelId: t.Union([t.String(), t.Null()]),
        name: t.String(),
        projectMartLargeRebuildBatchSize: t.Union([t.Numeric(), t.Null()]),
        projectMartLargeRebuildMaxCyclesPerWake: t.Union([t.Numeric(), t.Null()]),
        projectMartLargeRebuildPollIntervalMs: t.Union([t.Numeric(), t.Null()]),
        projectMartLargeRebuildTuningMode: t.Union([t.Literal('automatic'), t.Literal('manual'), t.Null()]),
        unpaywallEmail: t.Union([t.String(), t.Null()]),
      }),
    },
  )
