export const getSubmittedManualWorkerUrls = ({
  manualWorkerUrls,
  workerUrls,
}: {
  manualWorkerUrls?: string[]
  workerUrls?: string[]
}) => {
  return manualWorkerUrls ?? workerUrls
}
