import {Elysia, t} from 'elysia'

import {
  resolveProjectTransferPersistedRuntimeAssetPath,
  validateProjectTransferRuntimeAssetPath,
} from '../services/projectTransfer/projectTransferPaths.ts'
import {withErrorHandler} from '../utils/routeErrorHandler.ts'

const getRuntimeAssetPath = (value: string) => {
  const validatedPath = validateProjectTransferRuntimeAssetPath(value)

  return validatedPath.ok ? validatedPath.value.path : null
}

export const runtimeAssetsRoutes = new Elysia().use(withErrorHandler()).get(
  '/api/runtime-asset',
  async ({query}) => {
    const assetPath = getRuntimeAssetPath(query.path)

    if (!assetPath) {
      throw new Error('Runtime asset not found')
    }

    const assetFile = globalThis.Bun.file(resolveProjectTransferPersistedRuntimeAssetPath({pathValue: assetPath}))

    if (!(await assetFile.exists())) {
      throw new Error('Runtime asset not found')
    }

    return new Response(assetFile, {headers: assetFile.type ? {'content-type': assetFile.type} : undefined})
  },
  {query: t.Object({path: t.String()})},
)
