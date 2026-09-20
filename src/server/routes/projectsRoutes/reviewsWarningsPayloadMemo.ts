export type ReviewsWarningsPayloadMemoMode = 'bypass' | 'memo' | 'refresh'

type ReviewsWarningsPayloadMemoEntry<T> = {expiresAtMs: number | null; value: Promise<T>}

type ReviewsWarningsPayloadMemoRead<T> = {compute: () => Promise<T>; key: string; mode: ReviewsWarningsPayloadMemoMode}

export const getReviewsWarningsPayloadMemoKey = (input: {
  projectId: string
  projectUpdatedAt: string | null
  reviewConfigHash: string | null
}) => {
  return [input.projectId, input.reviewConfigHash ?? '', input.projectUpdatedAt ?? ''].join('|')
}

const isInFlightEntry = <T>(entry: ReviewsWarningsPayloadMemoEntry<T>) => {
  return entry.expiresAtMs === null
}

const isFreshSettledEntry = <T>(entry: ReviewsWarningsPayloadMemoEntry<T>, nowMs: number) => {
  return entry.expiresAtMs !== null && entry.expiresAtMs > nowMs
}

export const createReviewsWarningsPayloadMemo = <T>(input: {now?: () => number; ttlMs: number}) => {
  const entries = new Map<string, ReviewsWarningsPayloadMemoEntry<T>>()
  const now = input.now ?? Date.now

  const getExpiredKeys = (nowMs: number) => {
    return [...entries]
      .filter(([, entry]) => {
        return entry.expiresAtMs !== null && entry.expiresAtMs <= nowMs
      })
      .map(([key]) => {
        return key
      })
  }

  const settleEntry = (key: string, entry: ReviewsWarningsPayloadMemoEntry<T>, fulfilled: boolean) => {
    const isCurrentEntry = entries.get(key) === entry

    if (isCurrentEntry && fulfilled) {
      entry.expiresAtMs = now() + input.ttlMs
    }

    if (isCurrentEntry && !fulfilled) {
      entries.delete(key)
    }
  }

  const store = (key: string, compute: () => Promise<T>) => {
    getExpiredKeys(now()).map((expiredKey) => {
      return entries.delete(expiredKey)
    })
    const entry: ReviewsWarningsPayloadMemoEntry<T> = {expiresAtMs: null, value: compute()}
    entries.set(key, entry)
    void entry.value.then(
      () => {
        settleEntry(key, entry, true)
      },
      () => {
        settleEntry(key, entry, false)
      },
    )

    return entry.value
  }

  const isReusableEntry = (entry: ReviewsWarningsPayloadMemoEntry<T> | undefined, mode: 'memo' | 'refresh') => {
    return entry !== undefined && (isInFlightEntry(entry) || (mode === 'memo' && isFreshSettledEntry(entry, now())))
  }

  const read = (request: ReviewsWarningsPayloadMemoRead<T>) => {
    if (request.mode === 'bypass') {
      return request.compute()
    }

    const entry = entries.get(request.key)

    return entry !== undefined && isReusableEntry(entry, request.mode)
      ? entry.value
      : store(request.key, request.compute)
  }

  return {
    clear: () => {
      entries.clear()
    },
    read,
    size: () => {
      return entries.size
    },
  }
}
