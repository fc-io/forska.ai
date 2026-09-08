import assert from 'node:assert/strict'
import {readFile, writeFile} from 'node:fs/promises'
import {join} from 'node:path'

import {file, spawn} from 'bun'
import {Effect} from 'effect'

import {assertDistributionHash} from './hashDistributionInput'

type DistributionInput = {filename: string; sha256: string; url: string; id?: number; mirrorUrl?: string}

const downloadArtifact = async (input: DistributionInput) => {
  assert.ok(input.id, 'GitHub artifact ID is required')
  const child = spawn(['gh', 'api', `repos/duckdb/duckdb/actions/artifacts/${input.id}/zip`], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [output, stderr, code] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  assert.equal(code, 0, `Cannot download official artifact ${input.id}: ${stderr}`)
  return new Uint8Array(output)
}

const downloadPublicFile = async (input: DistributionInput) => {
  const response = await fetch(input.mirrorUrl ?? input.url, {signal: AbortSignal.timeout(120000)})
  assert.ok(response.ok, `Cannot download ${input.filename}: HTTP ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}

const downloadInput = (input: DistributionInput) => {
  return input.id && !input.mirrorUrl ? downloadArtifact(input) : downloadPublicFile(input)
}

export const acquireDistributionInput = (input: DistributionInput, directory: string, offline: boolean) => {
  return Effect.tryPromise(async () => {
    assert.match(input.filename, /^[a-zA-Z0-9_.-]+$/, 'unsafe input filename')
    const path = join(directory, input.filename)
    const exists = await file(path).exists()
    assert.ok(exists || !offline, `Missing pinned input in offline mode: ${path}`)
    const bytes = exists ? new Uint8Array(await readFile(path)) : await downloadInput(input)
    assertDistributionHash(bytes, input.sha256, input.filename)
    if (!exists) {
      await writeFile(path, bytes, {flag: 'wx'})
    }
    return bytes
  })
}
