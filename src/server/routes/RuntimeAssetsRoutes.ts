import {Elysia, t} from 'elysia'

import {withErrorHandler} from '../utils/routeErrorHandler.ts'
import {resolveRuntimeFilePath} from '../utils/runtimeWritablePath.ts'

const getRuntimeAssetPath = (value: string) => {
  const normalizedValue = value.trim().replace(/\\/g, '/')

  return normalizedValue.startsWith('assets/') ? normalizedValue : null
}

export const runtimeAssetsRoutes = new Elysia().use(withErrorHandler()).get(
  '/api/runtime-asset',
  async ({query}) => {
    const assetPath = getRuntimeAssetPath(query.path)

    if (!assetPath) {
      throw new Error('Runtime asset not found')
    }

    const assetFile = globalThis.Bun.file(resolveRuntimeFilePath({pathValue: assetPath}))

    if (!(await assetFile.exists())) {
      throw new Error('Runtime asset not found')
    }

    return new Response(assetFile, {headers: assetFile.type ? {'content-type': assetFile.type} : undefined})
  },
  {query: t.Object({path: t.String()})},
)
