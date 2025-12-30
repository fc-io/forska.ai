/**
 * Transfer HuggingFace model and SGLang container to MareNostrum 5
 * Usage: bun run scripts/mn5Transfer.ts [--model <id>] [--skip-download] [--skip-container]
 */

import {$} from 'bun'
import {existsSync, mkdirSync, statSync, writeFileSync} from 'fs'
import {basename, join} from 'path'

const MN5_ROOT = '/gpfs/projects/ehpc482/dev'
const TLOG = 'tlog' // Transfer login (for rsync, any login node)
const GLOG = 'glog' // General purpose login (has singularity module) - add to ~/.ssh/config
const MODELS_DIR = './models'
const DEFAULT_MODEL = 'openai/gpt-oss-120b'

const log = (m: string): void => {
  console.log(`[mn5] ${m}`)
}
const fail = (m: string): never => {
  console.error(`[ERROR] ${m}`)
  process.exit(1)
}

const modelToCacheName = (id: string): string => {
  return `models--${id.replace(/\//g, '--')}`
}

const main = async () => {
  const args = process.argv.slice(2)
  let model = DEFAULT_MODEL
  let skipDl = false
  let skipContainer = false
  let containerOnly = false

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--model') model = args[++i] ?? fail('--model needs value')
    else if (args[i] === '--skip-download') skipDl = true
    else if (args[i] === '--skip-container') skipContainer = true
    else if (args[i] === '--container-only') containerOnly = true
  }

  const localModel = join(MODELS_DIR, basename(model))
  const tarball = join(MODELS_DIR, 'sglang_latest.tar')

  if (containerOnly) {
    log('Container-only mode: updating SGLang container')
  } else {
    log(`Model: ${model}`)
  }
  log(`Target: ${TLOG}:${MN5_ROOT}`)

  // 1. Download model (skip in container-only mode)
  if (!containerOnly && !skipDl && !existsSync(localModel)) {
    log('Downloading model...')
    mkdirSync(MODELS_DIR, {recursive: true})
    await $`huggingface-cli download ${model} --local-dir ${localModel} --local-dir-use-symlinks False`
  }

  // 2. Prepare container
  if (!skipContainer && !existsSync(tarball)) {
    log('Pulling and saving container (linux/amd64 for MN5)...')
    // Must explicitly specify amd64 platform since we might be on Apple Silicon
    await $`docker pull --platform linux/amd64 lmsysorg/sglang:latest`
    await $`docker save lmsysorg/sglang:latest -o ${tarball}`

    // Validate the tarball was created correctly (should be ~14GB, fail if < 1GB)
    const MIN_SIZE_BYTES = 1_000_000_000 // 1GB minimum
    const actualSize = statSync(tarball).size
    if (actualSize < MIN_SIZE_BYTES) {
      // Delete the corrupted file
      await $`rm -f ${tarball}`
      fail(
        `Container tarball is too small (${(actualSize / 1_000_000).toFixed(1)}MB). `
          + `Expected ~14GB. This usually means Docker disconnected during save. `
          + `Please restart OrbStack/Docker and try again.`,
      )
    }
    log(`Container saved successfully (${(actualSize / 1_000_000_000).toFixed(1)}GB)`)
  }

  // 3. Create remote dirs
  log('Creating remote directories...')
  await $`ssh ${TLOG} mkdir -p ${MN5_ROOT}/{hf_cache,logs,.cache,.cache/sglang,.secrets,tmp}`

  // 4. Transfer model (skip in container-only mode)
  if (!containerOnly) {
    log('Transferring model...')
    const remotePath = `${MN5_ROOT}/hf_cache/${modelToCacheName(model)}/`
    await $`rsync -avzP ${localModel}/ ${TLOG}:${remotePath}`
  }

  // 5. Transfer and convert container
  if (!skipContainer) {
    // Check if remote already has the latest tarball by comparing file sizes
    const localSize = existsSync(tarball) ? statSync(tarball).size : 0
    const remoteTarPath = `${MN5_ROOT}/sglang_latest.tar`

    let remoteSizeStr = ''
    try {
      // Get remote file size (returns empty if file doesn't exist)
      const result = await $`ssh ${TLOG} stat -c%s ${remoteTarPath} 2>/dev/null || echo "0"`.text()
      remoteSizeStr = result.trim()
    } catch {
      remoteSizeStr = '0'
    }
    const remoteSize = parseInt(remoteSizeStr, 10) || 0

    // Skip transfer if sizes match (same file)
    const sizesMatch = localSize > 0 && localSize === remoteSize

    if (sizesMatch) {
      log(`Remote already has latest tarball (${(localSize / 1_000_000_000).toFixed(1)}GB) - skipping transfer`)
    } else {
      if (remoteSize > 0) {
        log(
          `Remote tarball size differs: local=${(localSize / 1_000_000_000).toFixed(2)}GB, remote=${(remoteSize / 1_000_000_000).toFixed(2)}GB`,
        )
      }
      log('Transferring container...')
      await $`rsync -avzP ${tarball} ${TLOG}:${MN5_ROOT}/`
    }

    // Convert to SIF using sbatch job (login nodes don't have enough memory for 33GB+ images)
    log('Submitting sbatch job to convert tar to SIF...')
    const convertScript = `#!/bin/bash
#SBATCH --job-name=sglang-sif-build
#SBATCH --account=ehpc482
#SBATCH --output=${MN5_ROOT}/logs/sif-build-%j.log
#SBATCH --error=${MN5_ROOT}/logs/sif-build-%j.log
#SBATCH --time=00:30:00
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=20
#SBATCH --gres=gpu:1
#SBATCH --partition=acc
#SBATCH --qos=acc_ehpc

cd ${MN5_ROOT}
module load singularity/4.1.5
echo "Building SIF from tar..."
singularity build --force sglang_latest.sif docker-archive:sglang_latest.tar
BUILD_EXIT=$?
if [ $BUILD_EXIT -eq 0 ]; then
  echo "Build successful, removing tar..."
  rm sglang_latest.tar
  echo "Done!"
else
  echo "Build failed with exit code $BUILD_EXIT"
  exit $BUILD_EXIT
fi
`
    // Write script locally and rsync to server
    const localScriptPath = join(MODELS_DIR, 'sif-build.sbatch')
    const remoteScriptPath = `${MN5_ROOT}/tmp/sif-build.sbatch`
    writeFileSync(localScriptPath, convertScript)
    await $`rsync -avzP ${localScriptPath} ${TLOG}:${remoteScriptPath}`

    const jobOutput = await $`ssh ${GLOG} "cd ${MN5_ROOT} && sbatch ${remoteScriptPath}"`.text()
    const jobMatch = jobOutput.match(/Submitted batch job (\d+)/)
    if (!jobMatch) {
      return fail(`Failed to submit sbatch job: ${jobOutput}`)
    }
    const jobId = jobMatch[1]
    log(`Submitted job ${jobId} - waiting for completion...`)

    // Poll for job completion
    let completed = false
    let lastState = ''
    while (!completed) {
      await new Promise((r) => {
        setTimeout(r, 5000)
      }) // Wait 5 seconds between checks
      const stateOutput = await $`ssh ${GLOG} "squeue -j ${jobId} -h -o %T 2>/dev/null || echo DONE"`.text()
      const state = stateOutput.trim()

      if (state !== lastState) {
        log(`Job ${jobId} state: ${state}`)
        lastState = state
      }

      if (state === 'DONE' || state === '' || state === 'COMPLETED') {
        completed = true
      } else if (state === 'FAILED' || state === 'CANCELLED' || state === 'TIMEOUT') {
        const logFile = `${MN5_ROOT}/logs/sif-build-${jobId}.log`
        log(`Job failed! Check log: ${logFile}`)
        await $`ssh ${GLOG} "tail -50 ${logFile}"`
        fail(`SIF build job ${jobId} failed with state: ${state}`)
      }
    }

    // Verify the SIF was created
    const sifExists =
      (await $`ssh ${TLOG} "test -f ${MN5_ROOT}/sglang_latest.sif && echo yes || echo no"`.text()).trim() === 'yes'
    if (!sifExists) {
      const logFile = `${MN5_ROOT}/logs/sif-build-${jobId}.log`
      log(`SIF file not found after job completion. Check log: ${logFile}`)
      await $`ssh ${GLOG} "tail -50 ${logFile}"`
      fail('SIF build may have failed - sglang_latest.sif not found')
    }

    log('SIF container built successfully!')
  }

  log('Done! Next: scp forska-mn5-sglang.sbatch tlog:/gpfs/projects/ehpc482/dev/')
}

void main()
