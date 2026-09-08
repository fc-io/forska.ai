const buildCommitEnvKeys = [
  'FORSKA_COMMIT_SHA',
  'FORSKA_GIT_SHA',
  'GIT_COMMIT',
  'GITHUB_SHA',
  'VERCEL_GIT_COMMIT_SHA',
  'COMMIT_SHA',
] as const

const getTrimmedEnvValue = (key: string) => {
  const value = process.env[key]?.trim()
  return value && value.length > 0 ? value : null
}

let cachedGitCommitSha: string | null | undefined

const getGitCommitSha = () => {
  if (cachedGitCommitSha !== undefined) {
    return cachedGitCommitSha
  }

  if (typeof globalThis.Bun?.spawnSync !== 'function') {
    cachedGitCommitSha = null
    return cachedGitCommitSha
  }

  try {
    const result = globalThis.Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {
      cwd: process.cwd(),
      env: process.env,
      stderr: 'pipe',
      stdout: 'pipe',
    })

    if (result.exitCode !== 0) {
      cachedGitCommitSha = null
      return cachedGitCommitSha
    }

    const commitSha = Buffer.from(result.stdout ?? [])
      .toString()
      .trim()

    cachedGitCommitSha = commitSha.length > 0 ? commitSha : null
    return cachedGitCommitSha
  } catch {
    cachedGitCommitSha = null
    return cachedGitCommitSha
  }
}

export const getRuntimeBuildInfo = () => {
  const envCommitSha =
    buildCommitEnvKeys.map(getTrimmedEnvValue).find((value) => {
      return value !== null
    }) ?? null
  const commitSha = envCommitSha ?? getGitCommitSha()

  return {
    commitSha: commitSha ?? 'unknown',
    commitShaSource: envCommitSha === null ? (commitSha === null ? 'unknown' : 'git') : 'env',
    shortCommitSha: commitSha === null ? 'unknown' : commitSha.slice(0, 12),
  }
}
