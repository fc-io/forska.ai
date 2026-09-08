import assert from 'node:assert/strict'
import {mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {expect, test} from 'bun:test'

import manifest from '../../vendor/duckdb/manifest.json'
import {getInstalledDuckdbDistribution} from './getInstalledDuckdbDistribution.ts'

test('a copied app missing its dependencies cannot pass by loading a parent installation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forska-duckdb-package-boundary-'))
  try {
    const scope = join(directory, 'node_modules', '@duckdb')
    const api = join(scope, 'node-api')
    const bindings = join(scope, 'node-bindings')
    const native = join(scope, `node-bindings-${process.platform}-${process.arch}`)
    const app = join(directory, 'copied-app')
    ;[api, bindings, native, app].map((path) => {
      return mkdirSync(path, {recursive: true})
    })
    ;[api, bindings].map((path) => {
      return writeFileSync(join(path, 'index.js'), 'throw new Error("Parent dependencies must never be loaded")')
    })
    writeFileSync(join(native, 'duckdb.node'), 'Parent native library must never be loaded')
    expect(() => {
      return getInstalledDuckdbDistribution(app)
    }).toThrow('Dependency resolved outside the verified application')
  } finally {
    rmSync(directory, {recursive: true, force: true})
  }
})

test('a copied native bridge cannot borrow its adjacent engine library from outside the bundle', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forska-duckdb-library-boundary-'))
  const platform = manifest.platforms.find((candidate) => {
    return candidate.platform === process.platform && candidate.arch === process.arch
  })
  assert.ok(platform)
  try {
    const app = join(directory, 'copied-app')
    const scope = join(app, 'node_modules', '@duckdb')
    const native = join(scope, platform.packageName.slice('@duckdb/'.length))
    ;['node-api', 'node-bindings', platform.packageName.slice('@duckdb/'.length)].map((name) => {
      const path = join(scope, name)
      mkdirSync(path, {recursive: true})
      writeFileSync(join(path, 'index.js'), 'throw new Error("Borrowed engine must never load")')
      return writeFileSync(join(path, 'package.json'), '{"main":"index.js"}')
    })
    ;['duckdb.node', 'FORSKA_DUCKDB_PROVENANCE.json', 'LICENSE', 'DUCKDB_LICENSE'].map((name) => {
      return writeFileSync(join(native, name), 'local fixture')
    })
    const external = join(directory, platform.native.filename)
    writeFileSync(external, 'Native engine outside the copied application')
    symlinkSync(external, join(native, platform.native.filename), 'file')
    expect(() => {
      return getInstalledDuckdbDistribution(app)
    }).toThrow('Dependency resolved outside the verified application')
  } finally {
    rmSync(directory, {recursive: true, force: true})
  }
})
