import {$} from 'bun'

const tag = (await $`git rev-parse --short HEAD`.text()).trim()
process.env.TAG = tag

await $`docker compose --profile hostnet build api-server-hostnet app-server-hostnet`
await $`docker compose --profile hostnet push api-server-hostnet app-server-hostnet`

console.log(`\n`)
console.log(`Built and pushed images to GHCR with tag ${tag} ----------------`)
console.log('Now pull images on remote:')
console.log(`apptainer pull --arch amd64 "$STACK_ROOT/api_server.sif" docker://ghcr.io/$GHCR_OWNER/api-server:${tag}`)
console.log(`apptainer pull --arch amd64 "$STACK_ROOT/app_server.sif" docker://ghcr.io/$GHCR_OWNER/app-server:${tag}`)
console.log(`----------------------------------------------------------------`)
