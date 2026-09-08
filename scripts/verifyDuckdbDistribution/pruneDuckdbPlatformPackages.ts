import assert from 'node:assert/strict'
import {lstatSync, readdirSync, rmSync} from 'node:fs'
import {basename, join} from 'node:path'

import manifest from '../../vendor/duckdb/manifest.json'

const nativePackageNames = new Set(
  manifest.platforms.map((platform) => {
    return platform.packageName.slice('@duckdb/'.length)
  }),
)

export const pruneDuckdbPlatformPackages = (nodeModulesPath: string, platform: string, arch: string): string[] => {
  const target = manifest.platforms.find((candidate) => {
    return candidate.platform === platform && candidate.arch === arch
  })
  assert.ok(target, `Unknown DuckDB target: ${platform}-${arch}`)
  assert.ok(!lstatSync(nodeModulesPath).isSymbolicLink(), 'Build node_modules must be a copied directory')
  const visit = (directory: string): string[] => {
    return readdirSync(directory, {withFileTypes: true}).flatMap((entry) => {
      const path = join(directory, entry.name)
      const isNativePackage = basename(directory) === '@duckdb' && nativePackageNames.has(entry.name)
      if (isNativePackage && `@duckdb/${entry.name}` !== target.packageName) {
        rmSync(path, {recursive: true, force: true})
        return [path]
      }
      return entry.isDirectory() ? visit(path) : []
    })
  }
  return visit(nodeModulesPath)
}
