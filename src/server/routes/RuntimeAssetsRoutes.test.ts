import {mkdirSync, rmSync, writeFileSync} from 'node:fs'
import {dirname} from 'node:path'

import {afterEach, expect, mock, spyOn, test} from 'bun:test'

import {resolveProjectTransferPersistedRuntimeAssetPath} from '../services/projectTransfer/projectTransferPaths.ts'
import {runtimeAssetsRoutes} from './RuntimeAssetsRoutes.ts'

const createdTestAssetRoots: string[] = []

afterEach(() => {
  mock.restore()
  createdTestAssetRoots.forEach((assetRoot) => {
    rmSync(assetRoot, {force: true, recursive: true})
  })
  createdTestAssetRoots.length = 0
})

const getRuntimeAssetResponse = (assetPath: string) => {
  const query = new URLSearchParams({path: assetPath}).toString()

  return runtimeAssetsRoutes.handle(new Request(`http://localhost/api/runtime-asset?${query}`))
}

const writeTestAsset = (assetPath: string, content: string) => {
  const absolutePath = resolveProjectTransferPersistedRuntimeAssetPath({pathValue: assetPath})
  const assetRoot = resolveProjectTransferPersistedRuntimeAssetPath({pathValue: 'assets/runtime-assets-route-test'})

  mkdirSync(dirname(absolutePath), {recursive: true})
  writeFileSync(absolutePath, content, 'utf8')
  createdTestAssetRoots.push(assetRoot)
}

test('serves runtime assets after validating persisted assets path', async () => {
  const assetPath = 'assets/runtime-assets-route-test/article.txt'
  writeTestAsset(assetPath, 'runtime asset content')

  const response = await getRuntimeAssetResponse(assetPath)

  expect(response.status).toBe(200)
  expect(await response.text()).toBe('runtime asset content')
})

test('rejects unsafe runtime asset paths before filesystem access', async () => {
  const bunFileSpy = spyOn(globalThis.Bun, 'file')
  spyOn(console, 'error').mockImplementation(() => {})
  const unsafePaths = [
    '/tmp/runtime-asset.pdf',
    'manifest.json',
    'assets/../package.json',
    'assets\\article_pdfs\\test.pdf',
    'assets//article_pdfs/test.pdf',
  ]

  const responses = await Promise.all(
    unsafePaths.map(async (assetPath) => {
      const response = await getRuntimeAssetResponse(assetPath)
      const body = await response.text()

      return {body, status: response.status}
    }),
  )

  expect(responses).toEqual(
    unsafePaths.map(() => {
      return {body: 'Runtime asset not found', status: 500}
    }),
  )
  expect(bunFileSpy.mock.calls).toHaveLength(0)
})
