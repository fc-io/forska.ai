export type ReviewsWarningsPayloadMemoMode = 'bypass' | 'memo' | 'refresh'

type ReviewsWarningsPayloadMemoEntry<T> = {expiresAtMs: number; value: Promise<T>}

type ReviewsWarningsPayloadMemoRead<T> = {compute: () => Promise<T>; key: string; mode: ReviewsWarningsPayloadMemoMode}

export const createReviewsWarningsPayloadMemo = <T>(input: {now?: () => number; ttlMs: number}) => {
  const entries = new Map<string, ReviewsWarningsPayloadMemoEntry<T>>()
  const now = input.now ?? Date.now

  const getExpiredKeys = (nowMs: number) => {
    return [...entries]
      .filter(([, entry]) => {
        return entry.expiresAtMs <= nowMs
      })
      .map(([key]) => {
        return key
      })
  }

  const forgetRejectedEntry = (key: string, entry: ReviewsWarningsPayloadMemoEntry<T>) => {
    if (entries.get(key) === entry) {
      entries.delete(key)
    }
  }

  const store = (key: string, compute: () => Promise<T>) => {
    const nowMs = now()
    getExpiredKeys(nowMs).map((expiredKey) => {
      return entries.delete(expiredKey)
    })
    const entry = {expiresAtMs: nowMs + input.ttlMs, value: compute()}
    entries.set(key, entry)
    entry.value.catch(() => {
      forgetRejectedEntry(key, entry)
    })

    return entry.value
  }

  const read = (request: ReviewsWarningsPayloadMemoRead<T>) => {
    if (request.mode === 'bypass') {
      return request.compute()
    }

    const entry = entries.get(request.key)
    const isReusable = request.mode === 'memo' && entry !== undefined && entry.expiresAtMs > now()

    return isReusable ? entry.value : store(request.key, request.compute)
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
