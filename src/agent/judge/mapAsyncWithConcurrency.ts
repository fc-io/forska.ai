export const mapAsyncWithConcurrency = async <T, U>({
  items,
  limit,
  mapItem,
}: {
  items: T[]
  limit: number
  mapItem: (item: T, index: number) => Promise<U>
}): Promise<U[]> => {
  const safeLimit = Math.max(1, Math.min(items.length, limit))

  const runLane = async (index: number): Promise<{index: number; value: U}[]> => {
    const item = items[index]

    return item === undefined ? [] : [{index, value: await mapItem(item, index)}, ...(await runLane(index + safeLimit))]
  }

  if (items.length === 0) {
    return []
  }

  const lanes = await Promise.allSettled(
    Array.from({length: safeLimit}, (_, index) => {
      return runLane(index)
    }),
  )
  const firstRejectedLane = lanes.find((lane) => {
    return lane.status === 'rejected'
  })

  if (firstRejectedLane?.status === 'rejected') {
    throw firstRejectedLane.reason
  }

  return lanes
    .flatMap((lane) => {
      return lane.status === 'fulfilled' ? lane.value : []
    })
    .sort((a, b) => {
      return a.index - b.index
    })
    .map((entry) => {
      return entry.value
    })
}
