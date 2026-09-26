import {sleep} from '../../utils/sleep.ts'

const europePmcFetchTimeoutMs = 20_000
const europePmcRetryDelays = [10_000, 60_000, 600_000, 1_200_000, 1_800_000, 3_600_000]

const getAbortReason = (signal: AbortSignal) => {
  return signal.reason instanceof Error ? signal.reason : new Error('Europe PMC request was aborted')
}

export const fetchEuropePmcWithRetry = (url: URL, signal: AbortSignal): Promise<Response> => {
  const retryOrReject = (i: number, error: unknown, reason: string): Promise<Response> => {
    const delay = europePmcRetryDelays[i]

    if (signal.aborted) {
      return Promise.reject(getAbortReason(signal))
    }

    if (delay === undefined) {
      return Promise.reject(error)
    }

    console.log(`${reason}. Retrying in ${delay / 1000}s (attempt ${i + 1}/${europePmcRetryDelays.length})`)
    return sleep(delay).then(() => {
      return attempt(i + 1)
    })
  }

  const attempt = (i: number): Promise<Response> => {
    if (signal.aborted) {
      return Promise.reject(getAbortReason(signal))
    }

    const timeoutController = new AbortController()
    const timer = setTimeout(() => {
      timeoutController.abort()
    }, europePmcFetchTimeoutMs)
    console.log(`Fetching Europe PMC URL: ${url.toString()}`)
    const p = fetch(url, {signal: AbortSignal.any([signal, timeoutController.signal])}).finally(() => {
      clearTimeout(timer)
    })
    return p.then(
      (res) => {
        console.log(`Europe PMC response: ${res.status} ${res.statusText}`)
        return res.ok
          ? res
          : retryOrReject(i, new Error(`Europe PMC HTTP ${res.status}`), `Request failed with status ${res.status}`)
      },
      (err: unknown) => {
        return retryOrReject(i, err, `Request failed: ${String(err)}`)
      },
    )
  }

  return attempt(0)
}
