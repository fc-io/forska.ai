import {$} from 'bun'

import {ALVIS_HOST, ALVIS_ROOT} from './alvisCommon.ts'

const nothrow = $.nothrow()

const log = (message: string): void => {
  console.log(`[alvis:sglang:pull] ${message}`)
}

const fail = (message: string): never => {
  console.error(`[alvis:sglang:pull] ${message}`)
  process.exit(1)
}

const cliArgs = process.argv.slice(2)

const cliOptions = cliArgs.reduce<{tag?: string; force: boolean}>(
  (accumulator, arg, index) => {
    return arg === '--tag'
      ? {...accumulator, tag: cliArgs[index + 1]}
      : arg === '--force'
        ? {...accumulator, force: true}
        : accumulator
  },
  {force: false},
)

const runRemoteNoThrow = async (command: string) => {
  return nothrow`ssh ${ALVIS_HOST} ${command}`
}

const getCurrentTag = async (): Promise<string> => {
  const envTag = process.env.TAG?.trim()
  if (envTag) return envTag

  const gitTag = (await $`git rev-parse --short HEAD`.text()).trim()
  return gitTag || fail('Could not determine image tag from git rev-parse --short HEAD')
}

const remoteFileExists = async (filePath: string): Promise<boolean> => {
  const result = await runRemoteNoThrow(`test -f "${filePath}"`)
  return result.exitCode === 0
}

const getRemotePaths = (stackRoot: string, tag: string) => {
  const taggedFilename = `sglang_${tag}.sif`
  return {
    taggedFilename,
    taggedPath: `${stackRoot}/${taggedFilename}`,
    latestPath: `${stackRoot}/sglang_latest.sif`,
    tagFilePath: `${stackRoot}/sglang_latest.tag`,
  }
}

const pullTaggedImage = async (stackRoot: string, imageRef: string, taggedPath: string): Promise<void> => {
  const pullCommand = [
    `mkdir -p "${stackRoot}"`,
    `tmp_path="${taggedPath}.tmp"`,
    `rm -f "$tmp_path"`,
    `apptainer pull --arch amd64 "$tmp_path" "${imageRef}"`,
    `mv "$tmp_path" "${taggedPath}"`,
  ].join(' && ')

  const result = await runRemoteNoThrow(pullCommand)

  if (result.exitCode === 0) return

  const loginHint = [
    'Remote apptainer pull failed.',
    `Ensure Alvis can read ghcr.io/${process.env.GHCR_OWNER?.trim() || 'fc-io'}/sglang-server and run:`,
    `ssh ${ALVIS_HOST} 'apptainer registry login --username "${process.env.GHCR_USER?.trim() || 'fc-io'}" oras://ghcr.io'`,
  ].join('\n')

  fail(loginHint)
}

const relinkLatestImage = async (
  stackRoot: string,
  taggedFilename: string,
  latestPath: string,
  tagFilePath: string,
  tag: string,
): Promise<void> => {
  const linkCommand = [
    `cd "${stackRoot}"`,
    `ln -sfn "${taggedFilename}" "${latestPath}"`,
    `printf '%s\n' "${tag}" > "${tagFilePath}"`,
  ].join(' && ')

  const result = await runRemoteNoThrow(linkCommand)
  if (result.exitCode !== 0) fail(`Failed to update ${latestPath}`)
}

const main = async (): Promise<void> => {
  const tag = (cliOptions.tag ?? (await getCurrentTag())).trim()
  const stackRoot = process.env.STACK_ROOT?.trim() || ALVIS_ROOT
  const ghcrOwner = process.env.GHCR_OWNER?.trim() || 'fc-io'
  const imageRef = `docker://ghcr.io/${ghcrOwner}/sglang-server:${tag}`
  const remotePaths = getRemotePaths(stackRoot, tag)

  log(`Ensuring remote dir exists: ${ALVIS_HOST}:${stackRoot}`)
  const mkdirResult = await runRemoteNoThrow(`mkdir -p "${stackRoot}"`)
  if (mkdirResult.exitCode !== 0) fail(`Failed to create remote directory ${stackRoot}`)

  const taggedExists = cliOptions.force ? false : await remoteFileExists(remotePaths.taggedPath)

  if (taggedExists) {
    log(`Remote image already exists: ${remotePaths.taggedPath}`)
  } else {
    log(`Pulling ${imageRef} to ${ALVIS_HOST}:${remotePaths.taggedPath}`)
    await pullTaggedImage(stackRoot, imageRef, remotePaths.taggedPath)
  }

  log(`Updating ${remotePaths.latestPath} -> ${remotePaths.taggedFilename}`)
  await relinkLatestImage(stackRoot, remotePaths.taggedFilename, remotePaths.latestPath, remotePaths.tagFilePath, tag)

  log(`Done: ${ALVIS_HOST}:${remotePaths.latestPath}`)
}

void main()
