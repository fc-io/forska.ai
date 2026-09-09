export type NativeConsoleJob = {
  id: number
  run_id: number
  run_attempt: number
  head_sha: string
  url: string
  run_url: string
  name: string
  status: string
  conclusion: string
  steps: {name: string; status: string; conclusion: string}[]
}
