import {runReviewServingBenchmarkSmoke} from '../src/server/reviewServing/reviewServingBenchmark.ts'

const result = await runReviewServingBenchmarkSmoke()

console.log(
  JSON.stringify(
    {
      fixture: result.fixture,
      metrics: result.metrics,
      releaseReport: result.releaseReport,
      sampleCount: result.samples.length,
      workload: result.workload,
    },
    null,
    2,
  ),
)
