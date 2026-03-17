import {$} from 'bun'

const tag = (await $`git rev-parse --short HEAD`.text()).trim()
process.env.TAG = tag

await $`docker compose --profile gpu build sglang`
await $`docker compose --profile gpu push sglang`

console.log(`\n`)
console.log(`Built and pushed SGLang image to GHCR with tag ${tag} ----------------`)
console.log('Now pull image on remote:')
console.log(
  `apptainer pull --arch amd64 "$STACK_ROOT/sglang_latest.sif" docker://ghcr.io/$GHCR_OWNER/sglang-server:${tag}`,
)
console.log(`----------------------------------------------------------------`)
