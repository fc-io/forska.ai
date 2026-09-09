import {nativeConsoleCases} from './nativeConsoleCases'
import {nativeVerificationFixture} from './nativeVerificationFixture'

export const nativeConsoleFixture = () => {
  const source = nativeVerificationFixture()
  const build = {
    ...source.build,
    platform: 'linux',
    arch: 'arm64',
    workflow: {repository: 'fc-io/forska.ai', runId: '123', runAttempt: '1', commit: '2'.repeat(40)},
  }
  const job = {
    id: 456,
    run_id: 123,
    run_attempt: 1,
    head_sha: '1'.repeat(40),
    url: 'https://api.github.com/repos/fc-io/forska.ai/actions/jobs/456',
    run_url: 'https://api.github.com/repos/fc-io/forska.ai/actions/runs/123',
    name: 'native-linux-arm64',
    status: 'completed',
    conclusion: 'success',
    steps: [
      'Build pinned source and run native regressions',
      'Stage immutable native package with official Node bridge',
      'Verify real predicates, UPDATE, WAL and low-memory checkpoint',
    ].map((name) => {
      return {name, status: 'completed', conclusion: 'success'}
    }),
  }
  const log = [
    `HEAD is now at 2222222 Merge ${job.head_sha} into ${'3'.repeat(40)}`,
    '[command]/usr/bin/git log -1 --format=%H',
    build.workflow.commit,
    `[0/18] (0%): ${nativeConsoleCases[0]}`,
    ...nativeConsoleCases.map((name, index) => {
      return `[${index + 1}/18] (${Math.floor(((index + 1) * 100) / 18)}%): ${name} took 0.001s`
    }),
    JSON.stringify(build),
  ]
    .map((line) => {
      return `2026-09-09T06:58:51.000Z ${line}`
    })
    .join('\n')
  return {source, build, job, log}
}
