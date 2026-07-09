import {
  compareReviewServingSyntheticBenchmarkArtifacts,
  readReviewServingSyntheticBenchmarkArtifact,
} from '../src/server/reviewServing/reviewServingSyntheticBenchmark.ts'

const getArgValue = (name: string) => {
  const prefix = `${name}=`
  const matchingArg = process.argv.slice(2).find((arg) => {
    return arg.startsWith(prefix)
  })

  return matchingArg ? matchingArg.slice(prefix.length) : null
}

const hasArg = (name: string) => {
  return process.argv.slice(2).includes(name)
}

const beforePath = getArgValue('--before')
const afterPath = getArgValue('--after')

if (!beforePath || !afterPath) {
  throw new Error('Usage: bun run bench:review-serving-compare -- --before=<before.json> --after=<after.json>')
}

const before = readReviewServingSyntheticBenchmarkArtifact(beforePath)
const after = readReviewServingSyntheticBenchmarkArtifact(afterPath)
const result = compareReviewServingSyntheticBenchmarkArtifacts({
  after,
  allowConfigDrift: hasArg('--allow-config-drift'),
  before,
  targetOperation: getArgValue('--target-operation'),
})

console.log(JSON.stringify(result, null, 2))

if (result.nonTargetRegressions.length > 0) {
  throw new Error(`Review-serving benchmark non-target regressions: ${JSON.stringify(result.nonTargetRegressions)}`)
}
