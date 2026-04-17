import {chmodSync, mkdirSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'

import {expect, test} from 'bun:test'

import {resolveDuckdbBinary} from './duckdbBinary.ts'

const createExecutableFile = (filePath: string) => {
  mkdirSync(dirname(filePath), {recursive: true})
  writeFileSync(filePath, '#!/bin/sh\nexit 0\n')
  chmodSync(filePath, 0o755)
}

const removeDirectoryIfExists = (directoryPath: string) => {
  rmSync(directoryPath, {force: true, recursive: true})
}

test('resolveDuckdbBinary prefers the configured binary when it is executable', () => {
  const rootDirectory = join(tmpdir(), `f1-duckdb-binary-configured-${Date.now()}`)
  const configuredBinary = join(rootDirectory, 'configured', 'duckdb')

  try {
    createExecutableFile(configuredBinary)

    expect(
      resolveDuckdbBinary({
        configuredBinary,
        homeDirectory: join(rootDirectory, 'home'),
        pathValue: join(rootDirectory, 'path'),
      }),
    ).toBe(configuredBinary)
  } finally {
    removeDirectoryIfExists(rootDirectory)
  }
})

test('resolveDuckdbBinary falls back to the installed DuckDB CLI directory when PATH is missing duckdb', () => {
  const rootDirectory = join(tmpdir(), `f1-duckdb-binary-installed-${Date.now()}`)
  const installedBinary = join(rootDirectory, 'home', '.duckdb', 'cli', '1.4.3', 'duckdb')

  try {
    createExecutableFile(installedBinary)

    expect(
      resolveDuckdbBinary({configuredBinary: null, homeDirectory: join(rootDirectory, 'home'), pathValue: ''}),
    ).toBe(installedBinary)
  } finally {
    removeDirectoryIfExists(rootDirectory)
  }
})

test('resolveDuckdbBinary honors Windows PATH separators and executable suffixes', () => {
  const rootDirectory = join(tmpdir(), `f1-duckdb-binary-windows-${Date.now()}`)
  const firstPathDirectory = join(rootDirectory, 'path-a')
  const secondPathDirectory = join(rootDirectory, 'path-b')
  const installedBinary = join(secondPathDirectory, 'duckdb.exe')

  try {
    createExecutableFile(installedBinary)

    expect(
      resolveDuckdbBinary({
        configuredBinary: null,
        homeDirectory: join(rootDirectory, 'home'),
        pathValue: `${firstPathDirectory};${secondPathDirectory}`,
        platform: 'win32',
      }),
    ).toBe(installedBinary)
  } finally {
    removeDirectoryIfExists(rootDirectory)
  }
})
