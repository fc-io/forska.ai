import {createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {join} from 'node:path'

import {Glob} from 'bun'

export const getNativeRecipeProvenance = async (root: string) => {
  const hash = (bytes: Uint8Array | string) => {
    return createHash('sha256').update(bytes).digest('hex')
  }
  const helperFiles = await Array.fromAsync(new Glob('scripts/buildPatchedDuckdb/*.ts').scan(root))
  const files = [
    'vendor/duckdb/native-build.json',
    'vendor/duckdb/native-build.cmake',
    '.github/workflows/duckdb-native-build.yml',
    'scripts/buildPatchedDuckdb.ts',
    ...helperFiles,
  ].sort()
  const inputs = await Promise.all(
    files.map(async (filename) => {
      return {filename, sha256: hash(await readFile(join(root, filename)))}
    }),
  )
  return {inputs, sha256: hash(JSON.stringify(inputs))}
}
