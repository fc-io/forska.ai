import assert from 'node:assert/strict'
import {readFile, writeFile} from 'node:fs/promises'
import {join} from 'node:path'

import {createDeterministicTarball} from '../buildDuckdbDistribution/createDeterministicTarball'
import {hashDistributionInput} from '../buildDuckdbDistribution/hashDistributionInput'
import {assertNativeRecipeMatches, normalizeNativeRecipe} from '../stagePatchedDuckdbDistribution/normalizeNativeRecipe'
import type {NativeBuild} from '../stagePatchedDuckdbDistribution/readNativeBuild'

export const retainNativeBuildInputs = async (builds: NativeBuild[], root: string, output: string) => {
  const first = builds[0]
  assert.ok(first, 'At least one verified build is required')
  const canonical = normalizeNativeRecipe(first.recipe)
  for (const build of builds) {
    assertNativeRecipeMatches(build.recipe, first.recipe)
    assert.deepEqual(build.patches, first.patches, 'Native targets used different engine patches')
  }
  const inputs = [...canonical.inputs, ...first.patches].map((input) => {
    return {...input, archiveFilename: input.filename.replaceAll('/', '--')}
  })
  assert.equal(
    new Set(
      inputs.map(({archiveFilename}) => {
        return archiveFilename
      }),
    ).size,
    inputs.length,
  )
  const files: Record<string, Uint8Array> = {}
  for (const input of inputs) {
    assert.ok(!input.filename.split('/').includes('..') && !input.filename.startsWith('/'))
    const bytes = await readFile(join(root, input.filename))
    assert.equal(hashDistributionInput(bytes), input.sha256, `Changed native release input: ${input.filename}`)
    files[input.archiveFilename] = bytes
  }
  const metadata = {
    sourceArchive: first.sourceArchive,
    sourceRevision: first.sourceRevision,
    sourceId: first.sourceId,
    recipeSha256: canonical.sha256,
    originalRecipes: builds
      .map((build) => {
        return {platform: build.platform, arch: build.arch, sha256: build.recipe.sha256}
      })
      .sort((left, right) => {
        return `${left.platform}-${left.arch}`.localeCompare(`${right.platform}-${right.arch}`, 'en')
      }),
    inputs,
  }
  files['NATIVE_BUILD_INPUTS.json'] = new TextEncoder().encode(`${JSON.stringify(metadata, null, 2)}\n`)
  const bytes = createDeterministicTarball(files)
  const filename = `duckdb-native-build-inputs-${first.distributionVersion}.tar.gz`
  await writeFile(join(output, filename), bytes, {flag: 'wx'})
  await writeFile(join(output, 'NATIVE_BUILD_INPUTS.json'), files['NATIVE_BUILD_INPUTS.json'], {flag: 'wx'})
  return {filename, sha256: hashDistributionInput(bytes)}
}
