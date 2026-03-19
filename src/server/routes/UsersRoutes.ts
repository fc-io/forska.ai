import {Elysia, t} from 'elysia'

import {getUserConfigQueryService} from '../services/userConfigQueryService.ts'
import {readLocalAppSettings, updateLocalAppSettings} from '../utils/localAppSettings.ts'
import {withErrorHandler} from '../utils/routeErrorHandler'

const getNullableString = (value: string | null): string | null => {
  const normalized = String(value ?? '').trim()

  return normalized === '' ? null : normalized
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
        codexBin: getNullableString(body.codexBin),
        duckdbBin: getNullableString(body.duckdbBin),
      })
      const userConfig = await getUserConfigQueryService().updateUserConfig({
        email: body.email,
        name: body.name,
        unpaywallEmail: getNullableString(body.unpaywallEmail),
      })

      return {data: {...userConfig, codexBin: localAppSettings.codexBin, duckdbBin: localAppSettings.duckdbBin}}
    },
    {
      body: t.Object({
        codexBin: t.Union([t.String(), t.Null()]),
        duckdbBin: t.Union([t.String(), t.Null()]),
        email: t.String(),
        name: t.String(),
        unpaywallEmail: t.Union([t.String(), t.Null()]),
      }),
    },
  )
