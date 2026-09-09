import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {join, resolve} from 'node:path'

import specification from '../../vendor/duckdb/native-build.json'
import {getNativeRecipeProvenance} from '../buildPatchedDuckdb/getNativeRecipeProvenance'

export type NativeBuild = {
  schemaVersion: number
  distributionVersion: string
  engineVersion: string
  sourceRevision: string
  sourceId: string
  sourceArchive: typeof specification.sourceArchive
  patches: {filename: string; sha256: string}[]
  extensionConfig: string
  recipe: {inputs: {filename: string; sha256: string}[]; sha256: string}
  platform: string
  arch: string
  library: {filename: string; sha256: string}
  workflow: {repository: string | null; runId: string | null; runAttempt: string | null; commit: string | null}
}

export const readNativeBuild = async (directory: string) => {
  const build = JSON.parse(await readFile(join(directory, 'native-build.json'), 'utf8')) as NativeBuild
  const root = resolve(import.meta.dir, '../..')
  const hash = (bytes: Uint8Array) => {
    return createHash('sha256').update(bytes).digest('hex')
  }
  assert.equal(build.schemaVersion, 1)
  assert.equal(build.distributionVersion, specification.distributionVersion)
  assert.equal(build.engineVersion, specification.engineVersion)
  assert.equal(build.sourceRevision, specification.sourceRevision)
  assert.deepEqual(build.sourceArchive, specification.sourceArchive)
  assert.equal(build.extensionConfig, specification.extensionConfig)
  assert.deepEqual(build.recipe, await getNativeRecipeProvenance(root))
  assert.equal(build.patches.length, specification.patches.length)
  for (const [index, filename] of specification.patches.entries()) {
    assert.deepEqual(build.patches[index], {filename, sha256: hash(await readFile(join(root, filename)))})
  }
  assert.equal(build.sourceId, specification.patchSha256.slice(0, 10))
  assert.match(build.library.filename, /^(libduckdb\.(so|dylib)|duckdb\.dll)$/)
  assert.equal(hash(await readFile(join(directory, build.library.filename))), build.library.sha256)
  return build
}
