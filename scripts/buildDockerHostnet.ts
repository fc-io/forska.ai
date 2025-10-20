import {$} from 'bun'

const tag = (await $`git rev-parse --short HEAD`.text()).trim()
process.env.TAG = tag

await $`docker compose --profile hostnet build api-server-hostnet app-server-hostnet`
await $`docker compose --profile hostnet push api-server-hostnet app-server-hostnet`

console.log(`Built and pushed images to GHCR with tag ${tag}`)
console.log(`--------------------------`)
console.log('Now pull images on remote:')
console.log(
  `apptainer pull --arch amd64 "$STACK_ROOT/api_server_${TAG}.sif" docker://ghcr.io/$GHCR_OWNER/api-server:${TAG}`,
)
console.log(
  `apptainer pull --arch amd64 "$STACK_ROOT/app_server_${TAG}.sif" docker://ghcr.io/$GHCR_OWNER/app-server:${TAG}`,
)
console.log(`--------------------------`)
