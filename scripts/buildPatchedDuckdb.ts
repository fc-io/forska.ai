import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {copyFile, mkdir, readFile, writeFile} from 'node:fs/promises'
import {join, resolve} from 'node:path'
import {parseArgs} from 'node:util'

import specification from '../vendor/duckdb/native-build.json'
import {assertNativeTestReport} from './buildPatchedDuckdb/assertNativeTestReport'
import {getNativeBuildArguments} from './buildPatchedDuckdb/getNativeBuildArguments'
import {getNativeRecipeProvenance} from './buildPatchedDuckdb/getNativeRecipeProvenance'
import {prepareNativeSource} from './buildPatchedDuckdb/prepareNativeSource'
import {readNativeCompiler} from './buildPatchedDuckdb/readNativeCompiler'
import {runNativeCommand} from './buildPatchedDuckdb/runNativeCommand'

const {values} = parseArgs({
  options: {
    'input-dir': {type: 'string'},
    'work-dir': {type: 'string'},
    'output-dir': {type: 'string'},
    'compiler-cache': {type: 'string'},
    'test-filter': {type: 'string'},
  },
  strict: true,
})
assert.ok(
  values['input-dir'] && values['work-dir'] && values['output-dir'] && values['test-filter'],
  'All build directories and the native regression filter are required',
)
const root = resolve(import.meta.dir, '..')
const work = resolve(values['work-dir'])
const output = resolve(values['output-dir'])
const source = join(work, 'source')
const build = join(work, 'build')
await mkdir(work, {recursive: true})
await mkdir(output, {recursive: true})
const log = join(output, 'native-build.log')
const inputs = await prepareNativeSource(root, resolve(values['input-dir']), source, log)
const buildArguments = getNativeBuildArguments({
  source,
  build,
  sourceId: inputs.sourceId,
  platform: process.platform,
  arch: process.arch,
  compilerCache: values['compiler-cache'],
})
await runNativeCommand(['cmake', '--version'], root, log)
await runNativeCommand(['cmake', ...buildArguments], root, log)
await runNativeCommand(
  ['cmake', '--build', build, '--target', 'duckdb', 'unittest', '--parallel', String(specification.parallelism)],
  root,
  log,
)
const executable = join(build, 'test', process.platform === 'win32' ? 'unittest.exe' : 'unittest')
await runNativeCommand(
  [executable, values['test-filter'], '--reporter', 'junit', '--out', join(output, 'native-tests.xml')],
  source,
  log,
)
const xml = await readFile(join(output, 'native-tests.xml'), 'utf8')
assertNativeTestReport(xml, values['test-filter'])
const filenames: Record<string, string> = {darwin: 'libduckdb.dylib', linux: 'libduckdb.so', win32: 'duckdb.dll'}
const filename = filenames[process.platform]
assert.ok(filename, 'Unsupported library target')
await copyFile(join(build, 'src', filename), join(output, filename))
await copyFile(join(source, 'LICENSE'), join(output, 'DUCKDB_LICENSE'))
await copyFile(join(build, 'CMakeCache.txt'), join(output, 'CMakeCache.txt'))
const sha256 = createHash('sha256')
  .update(await readFile(join(output, filename)))
  .digest('hex')
const provenance = {
  schemaVersion: 1,
  distributionVersion: specification.distributionVersion,
  engineVersion: specification.engineVersion,
  sourceRevision: specification.sourceRevision,
  sourceId: inputs.sourceId.slice(0, 10),
  sourceArchive: inputs.sourceArchive,
  patches: inputs.patches,
  extensionConfig: specification.extensionConfig,
  buildArguments,
  compiler: await readNativeCompiler(build),
  recipe: await getNativeRecipeProvenance(root),
  platform: process.platform,
  arch: process.arch,
  library: {filename, sha256},
  workflow: {
    repository: process.env.GITHUB_REPOSITORY ?? null,
    runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    commit: process.env.GITHUB_SHA ?? null,
  },
}
await writeFile(join(output, 'native-build.json'), `${JSON.stringify(provenance, null, 2)}\n`, {flag: 'wx'})
console.log(JSON.stringify(provenance))
