import {Elysia, t} from 'elysia'

import {withErrorHandler} from '../utils/routeErrorHandler'
import {modelsRoutesGetCodexLoginJob} from './modelsRoutes/modelsRoutesGetCodexLoginJob.ts'
import {modelsRoutesGetCodexStatus} from './modelsRoutes/modelsRoutesGetCodexStatus.ts'
import {modelsRoutesGetGpuInfo} from './modelsRoutes/modelsRoutesGetGpuInfo.ts'
import {modelsRoutesGetModels} from './modelsRoutes/modelsRoutesGetModels.ts'
import {modelsRoutesGetStored} from './modelsRoutes/modelsRoutesGetStored.ts'
import {modelsRoutesPostCodexLogin} from './modelsRoutes/modelsRoutesPostCodexLogin.ts'
import {modelsRoutesPostEnsure} from './modelsRoutes/modelsRoutesPostEnsure.ts'
import {providerConnectionsRoutes} from './ProviderConnectionsRoutes.ts'
import {providerModelsRoutes} from './ProviderModelsRoutes.ts'

export const modelsRoutes = new Elysia()
  .use(withErrorHandler())
  .get('/api/models', async () => {
    return modelsRoutesGetModels()
  })
  .get('/api/models/stored', async () => {
    return modelsRoutesGetStored()
  })
  .get('/api/models/codex/status', async () => {
    return modelsRoutesGetCodexStatus()
  })
  .post('/api/models/codex/login', async () => {
    return modelsRoutesPostCodexLogin()
  })
  .get(
    '/api/models/codex/login/:jobId',
    async ({params, set}) => {
      return modelsRoutesGetCodexLoginJob({params, set})
    },
    {params: t.Object({jobId: t.String()})},
  )
  .post(
    '/api/models/ensure',
    async ({body, set}) => {
      return modelsRoutesPostEnsure({body, set})
    },
    {
      body: t.Object({
        modelName: t.String(),
        name: t.String(),
        provider: t.String(),
        providerConnectionId: t.Optional(t.String()),
        version: t.Optional(t.String()),
      }),
    },
  )
  .use(providerConnectionsRoutes)
  .use(providerModelsRoutes)
  .get('/api/models/gpu-info', async () => {
    return modelsRoutesGetGpuInfo()
  })
