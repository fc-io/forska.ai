import assert from 'node:assert/strict'
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {Archive} from 'bun'
import {expect, test} from 'bun:test'

import specification from '../../vendor/duckdb/native-build.json'
import {hashDistributionInput} from '../buildDuckdbDistribution/hashDistributionInput'
import type {NativeBuild} from '../stagePatchedDuckdbDistribution/readNativeBuild'
import {retainNativeBuildInputs} from './retainNativeBuildInputs'

const fixture = async (root: string): Promise<NativeBuild> => {
  await mkdir(join(root, 'scripts'))
  await writeFile(join(root, 'scripts/build.cmake'), 'exact hook\n')
  await writeFile(join(root, 'source.patch'), 'exact patch\n')
  const inputs = [{filename: 'scripts/build.cmake', sha256: hashDistributionInput(Buffer.from('exact hook\n'))}]
  return {
    schemaVersion: 1,
    distributionVersion: specification.distributionVersion,
    engineVersion: specification.engineVersion,
    sourceRevision: specification.sourceRevision,
    sourceId: '0123456789',
    sourceArchive: specification.sourceArchive,
    patches: [{filename: 'source.patch', sha256: hashDistributionInput(Buffer.from('exact patch\n'))}],
    extensionConfig: specification.extensionConfig,
    recipe: {sha256: hashDistributionInput(Buffer.from(JSON.stringify(inputs))), inputs},
    platform: 'darwin',
    arch: 'arm64',
    library: {filename: 'libduckdb.dylib', sha256: 'library'},
    workflow: {repository: null, runId: null, runAttempt: null, commit: null},
  }
}

test('release source bundle retains exact patch and recipe bytes with deterministic original-path mapping', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forska-native-release-inputs-'))
  const second = await mkdtemp(join(tmpdir(), 'forska-native-release-inputs-repeated-'))
  try {
    const build = await fixture(root)
    const windowsInputs = build.recipe.inputs.map((input) => {
      return {...input, filename: input.filename.replaceAll('/', '\\')}
    })
    const windows = {
      ...build,
      platform: 'win32',
      arch: 'x64',
      recipe: {inputs: windowsInputs, sha256: hashDistributionInput(Buffer.from(JSON.stringify(windowsInputs)))},
    }
    const first = await retainNativeBuildInputs([windows, build], root, root)
    const repeated = await retainNativeBuildInputs([build, windows], root, second)
    expect(first).toEqual(repeated)
    const archive = new Archive(await readFile(join(root, first.filename)))
    const files = await archive.files()
    expect(await files.get('source.patch')?.text()).toBe('exact patch\n')
    expect(await files.get('scripts--build.cmake')?.text()).toBe('exact hook\n')
    const mapping = await readFile(join(root, 'NATIVE_BUILD_INPUTS.json'), 'utf8')
    expect(mapping).toContain('source.patch')
    expect(mapping).toContain(specification.sourceArchive.sha256)
    const metadata = JSON.parse(mapping) as {recipeSha256: unknown; originalRecipes: unknown}
    expect(metadata.recipeSha256).toBe(build.recipe.sha256)
    expect(metadata.originalRecipes).toEqual([
      {platform: 'darwin', arch: 'arm64', sha256: build.recipe.sha256},
      {platform: 'win32', arch: 'x64', sha256: windows.recipe.sha256},
    ])
    expect(windows.recipe.sha256).not.toBe(build.recipe.sha256)
  } finally {
    await Promise.all([rm(root, {recursive: true, force: true}), rm(second, {recursive: true, force: true})])
  }
})

test('release source bundle rejects changed source bytes and mismatched platform recipes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forska-native-release-inputs-tamper-'))
  try {
    const build = await fixture(root)
    await writeFile(join(root, 'source.patch'), 'changed patch\n')
    await assert.rejects(retainNativeBuildInputs([build], root, root), /Changed native release input/)
    const divergentInputs = [{filename: 'scripts/build.cmake', sha256: 'a'.repeat(64)}]
    const divergent = {
      ...build,
      recipe: {inputs: divergentInputs, sha256: hashDistributionInput(Buffer.from(JSON.stringify(divergentInputs)))},
    }
    await assert.rejects(retainNativeBuildInputs([build, divergent], root, root), /different build recipes/)
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})
