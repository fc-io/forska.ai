import {appendFileSync, existsSync, rmSync} from 'node:fs'
import {join} from 'node:path'

type TopologyArtifacts = {
  failureRecorded?: boolean
  preserveFailureArtifacts?: boolean
  root: string
}

export const topologyFailureArtifactsDirectory = 'judgment-workflow-failure-evidence'

export const recordTopologyFailure = (topology: TopologyArtifacts, stage: string) => {
  topology.failureRecorded = true
  if (topology.preserveFailureArtifacts && existsSync(topology.root)) {
    appendFileSync(
      join(topology.root, 'failure.jsonl'),
      `${JSON.stringify({recordedAt: new Date().toISOString(), stage})}\n`,
    )
    console.error(`[judgment-workflow] preserving failed synthetic topology at ${topology.root}`)
  }
}

export const cleanupTopologyArtifacts = (topology: TopologyArtifacts) => {
  if (!topology.preserveFailureArtifacts || !topology.failureRecorded) {
    rmSync(topology.root, {force: true, recursive: true})
    if (existsSync(topology.root)) {
      throw new Error(`Production topology root was not removed: ${topology.root}`)
    }
  }
}
