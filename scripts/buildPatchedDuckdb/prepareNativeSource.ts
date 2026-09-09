import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {join, resolve} from 'node:path'

import {file} from 'bun'

import specification from '../../vendor/duckdb/native-build.json'
import {runNativeCommand} from './runNativeCommand'

export const prepareNativeSource = async (root: string, inputDirectory: string, source: string, log: string) => {
  const hash = (bytes: Uint8Array) => {
    return createHash('sha256').update(bytes).digest('hex')
  }
  await mkdir(inputDirectory, {recursive: true})
  const archive = join(inputDirectory, specification.sourceArchive.filename)
  if (!(await file(archive).exists())) {
    const response = await fetch(specification.sourceArchive.url, {signal: AbortSignal.timeout(180000)})
    assert.ok(response.ok, `Cannot obtain pinned source: HTTP ${response.status}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    assert.equal(hash(bytes), specification.sourceArchive.sha256, 'Source archive checksum mismatch')
    await writeFile(archive, bytes, {flag: 'wx'})
  }
  assert.equal(
    hash(await readFile(archive)),
    specification.sourceArchive.sha256,
    'Cached source archive checksum mismatch',
  )
  await mkdir(source)
  await runNativeCommand(['tar', '-xzf', archive, '--strip-components=1', '-C', source], root, log)
  const patches = []
  for (const filename of specification.patches) {
    const path = resolve(root, filename)
    const bytes = await readFile(path)
    assert.ok(bytes.length > 0, 'Native patch cannot be empty')
    assert.equal(hash(bytes), specification.patchSha256, 'Native patch checksum mismatch')
    await runNativeCommand(['git', 'apply', '--check', path], source, log)
    await runNativeCommand(['git', 'apply', path], source, log)
    patches.push({filename, sha256: hash(bytes)})
  }
  assert.equal(patches.length, 1, 'Changing the patch set requires an explicit patched source identity review')
  const firstPatch = patches[0]
  assert.ok(firstPatch)
  return {patches, sourceId: firstPatch.sha256, sourceArchive: specification.sourceArchive}
}
