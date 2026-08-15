import {mkdtempSync, rmSync} from 'node:fs'
import {readdir, readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {afterAll, expect, test} from 'bun:test'

import {
  getProjectTransferCanonicalJsonChunks,
  projectTransferCanonicalJsonChunkMaxBytes,
  writeProjectTransferCanonicalJsonArtifact,
} from './projectTransferCanonicalJsonArtifact.ts'
import {getProjectTransferCanonicalJson} from './projectTransferFingerprint.ts'

const runtimeRoot = mkdtempSync(join(tmpdir(), `f2-project-transfer-canonical-json-${process.pid}-`))

afterAll(() => {
  rmSync(runtimeRoot, {force: true, recursive: true})
})

test('streams byte-identical canonical JSON in bounded chunks', () => {
  const sparseValues = Array<string>(4)
  sparseValues[1] = 'middle'
  sparseValues[3] = 'tail'
  const value = {
    omitted: undefined,
    sparseValues,
    strings: [
      'quote"slash\\controls\b\f\n\r\t\u0000',
      '\ud800',
      '\udc00',
      `${'a'.repeat(16_383)}\u{1f642}`,
      '\u{1f642}\u6f22\u5b57'.repeat(20_000),
    ],
    unordered: {z: 3, a: {d: 4, c: 3}},
  }
  const chunks = [...getProjectTransferCanonicalJsonChunks(value)]
  const bytes = Buffer.concat(
    chunks.map((chunk) => {
      return Buffer.from(chunk)
    }),
  )

  expect(bytes.toString('utf8')).toBe(getProjectTransferCanonicalJson(value))
  expect(chunks.length).toBeGreaterThan(1)
  expect(
    Math.max(
      ...chunks.map((chunk) => {
        return chunk.byteLength
      }),
    ),
  ).toBeLessThanOrEqual(projectTransferCanonicalJsonChunkMaxBytes)
})

test('publishes a complete canonical artifact with an atomic rename', async () => {
  const targetPath = join(runtimeRoot, 'success', 'artifact.json')
  const value = {
    rows: Array.from({length: 5_000}, (_entry, index) => {
      return {id: index, value: `row-${index}`}
    }),
  }
  await writeProjectTransferCanonicalJsonArtifact({filePath: targetPath, value: {status: 'previous'}})
  await writeProjectTransferCanonicalJsonArtifact({filePath: targetPath, value})

  expect(await readFile(targetPath, 'utf8')).toBe(getProjectTransferCanonicalJson(value))
  expect(await readdir(join(runtimeRoot, 'success'))).toEqual(['artifact.json'])
})

test('preserves the prior artifact and removes the temporary file when serialization fails', async () => {
  const targetDirectory = join(runtimeRoot, 'failure')
  const targetPath = join(targetDirectory, 'artifact.json')
  await writeProjectTransferCanonicalJsonArtifact({filePath: targetPath, value: {status: 'previous'}})

  const serializationError = await writeProjectTransferCanonicalJsonArtifact({
    filePath: targetPath,
    value: {
      aRows: Array.from({length: 1_000}, (_entry, index) => {
        return index
      }),
      zInvalid: 1n,
    },
  }).catch((error: unknown) => {
    return error
  })

  expect(serializationError).toBeInstanceOf(Error)
  expect(await readFile(targetPath, 'utf8')).toBe('{"status":"previous"}')
  expect(await readdir(targetDirectory)).toEqual(['artifact.json'])
})
