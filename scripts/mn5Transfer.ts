/**
 * Transfer HuggingFace model and SGLang container to MareNostrum 5
 * Usage: bun run scripts/mn5Transfer.ts [--model <id>] [--skip-download] [--skip-container]
 */

import {$} from 'bun'
import {existsSync, mkdirSync} from 'fs'
import {basename, join} from 'path'

const MN5_ROOT = '/gpfs/projects/ehpc482/dev'
const TLOG = 'tlog' // Transfer login (for rsync, any login node)
const GLOG = 'glog' // General purpose login (has singularity module) - add to ~/.ssh/config
const MODELS_DIR = './models'
const DEFAULT_MODEL = 'XiaomiMiMo/MiMo-V2-Flash'

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

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--model') model = args[++i] ?? fail('--model needs value')
    else if (args[i] === '--skip-download') skipDl = true
    else if (args[i] === '--skip-container') skipContainer = true
  }

  const localModel = join(MODELS_DIR, basename(model))
  const tarball = join(MODELS_DIR, 'sglang_latest.tar.gz')

  log(`Model: ${model}`)
  log(`Target: ${TLOG}:${MN5_ROOT}`)

  // 1. Download model
  if (!skipDl && !existsSync(localModel)) {
    log('Downloading model...')
    mkdirSync(MODELS_DIR, {recursive: true})
    await $`huggingface-cli download ${model} --local-dir ${localModel} --local-dir-use-symlinks False`
  }

  // 2. Prepare container
  if (!skipDl && !skipContainer && !existsSync(tarball)) {
    log('Pulling and saving container...')
    await $`docker pull lmsysorg/sglang:latest`
    await $`docker save lmsysorg/sglang:latest | gzip > ${tarball}`
  }

  // 3. Create remote dirs
  log('Creating remote directories...')
  await $`ssh ${TLOG} mkdir -p ${MN5_ROOT}/{hf_cache,logs,.cache,.cache/sglang,.secrets,tmp}`

  // 4. Transfer model
  log('Transferring model...')
  const remotePath = `${MN5_ROOT}/hf_cache/${modelToCacheName(model)}/`
  await $`rsync -avzP ${localModel}/ ${TLOG}:${remotePath}`

  // 5. Transfer and convert container
  if (!skipContainer) {
    log('Transferring container...')
    await $`rsync -avzP ${tarball} ${TLOG}:${MN5_ROOT}/`
    log('Converting to SIF on general login node (this takes a while)...')
    // Note: Must use glogin (general purpose) - alogin (ACC) doesn't have singularity module
    const convertCmd = `
      cd ${MN5_ROOT} && \\
      module load singularity/4.1.5 && \\
      which singularity || which apptainer || (echo "ERROR: Neither singularity nor apptainer found" && exit 1) && \\
      singularity build sglang_latest.sif docker-archive:sglang_latest.tar.gz && \\
      rm sglang_latest.tar.gz
    `
    await $`ssh ${GLOG} ${convertCmd}`
  }

  log('Done! Next: scp forska-mn5-sglang.sbatch tlog:/gpfs/projects/ehpc482/dev/')
}

void main()
