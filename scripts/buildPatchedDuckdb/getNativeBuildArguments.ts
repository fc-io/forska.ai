import assert from 'node:assert/strict'
import {join, resolve} from 'node:path'

import specification from '../../vendor/duckdb/native-build.json'

export const getNativeBuildArguments = (options: {
  source: string
  build: string
  sourceId: string
  platform: string
  arch: string
  compilerCache?: string
}) => {
  assert.ok(['linux', 'darwin', 'win32'].includes(options.platform), 'Unsupported native build OS')
  assert.ok(['x64', 'arm64'].includes(options.arch), 'Unsupported native build architecture')
  assert.match(options.sourceId, /^[a-f0-9]{64}$/, 'Patched source identity must be a full SHA-256')
  const args = [
    '-S',
    options.source,
    '-B',
    options.build,
    '-G',
    'Ninja',
    '-DCMAKE_BUILD_TYPE=Release',
    `-DCMAKE_PROJECT_INCLUDE=${resolve(import.meta.dir, '../../vendor/duckdb/native-build.cmake')}`,
    '-DBUILD_UNITTESTS=ON',
    '-DENABLE_UNITTEST_CPP_TESTS=ON',
    '-DBUILD_SHELL=OFF',
    '-DDISABLE_UNITY=ON',
    '-DENABLE_EXTENSION_AUTOLOADING=ON',
    '-DENABLE_EXTENSION_AUTOINSTALL=ON',
    `-DDUCKDB_EXTENSION_CONFIGS=${join(options.source, specification.extensionConfig)}`,
    `-DDUCKDB_EXPLICIT_VERSION=${specification.engineVersion}`,
    `-DGIT_COMMIT_HASH=${options.sourceId}`,
  ]
  if (options.compilerCache) {
    args.push(
      `-DCMAKE_C_COMPILER_LAUNCHER=${options.compilerCache}`,
      `-DCMAKE_CXX_COMPILER_LAUNCHER=${options.compilerCache}`,
    )
  }
  if (options.platform === 'darwin') {
    args.push(
      `-DCMAKE_OSX_ARCHITECTURES=${options.arch === 'arm64' ? 'arm64' : 'x86_64'}`,
      '-DCMAKE_OSX_DEPLOYMENT_TARGET=11.0',
    )
  }
  if (options.platform === 'linux') {
    args.push('-DSTATIC_LIBCPP=ON')
  }
  if (options.platform === 'win32') {
    const target = options.arch === 'arm64' ? 'arm64-pc-windows-msvc' : 'x86_64-pc-windows-msvc'
    args.push(
      '-DCMAKE_C_COMPILER=clang-cl',
      '-DCMAKE_CXX_COMPILER=clang-cl',
      `-DCMAKE_C_COMPILER_TARGET=${target}`,
      `-DCMAKE_CXX_COMPILER_TARGET=${target}`,
    )
  }
  return args
}
