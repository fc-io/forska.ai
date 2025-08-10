import {fetchTokensAllTime} from '../components/main/unassessedArticles/unassessedArticlesFetchTokensAllTime.ts'
// import {fetchTokenUseLast10Minutes} from '../components/main/unassessedArticles/unassessedArticlesFetchTokenUseLast10Minutes.ts'
// import {fetchTokenUseToday} from '../components/main/unassessedArticles/unassessedArticlesFetchTokenUseToday.ts'
import {fetchUnassessedCount} from '../components/main/unassessedArticles/unassessedArticlesFetchUnassessedCount.ts'
import {setInfoState} from '../stores/info.ts'

let updateInterval: ReturnType<typeof setInterval> | null = null

const handleFetchUnassessedCount = async () => {
  // debugger
  const count = await fetchUnassessedCount()
  if (count !== null) {
    setInfoState('unassessedCount', count)
    setInfoState('lastUpdated', new Date())
  }
}

// const handleFetchTokenUseToday = async () => {
//   const msg = await fetchTokenUseToday()
//   setInfoState('tokenUseToday', msg)
// }

// const handleFetchTokenUseLast10Minutes = async () => {
//   const msg = await fetchTokenUseLast10Minutes()
//   setInfoState('tokenUseLast10Minutes', msg)
// }

const handleFetchTokensAllTime = async () => {
  const msg = await fetchTokensAllTime()
  setInfoState('tokenUseLifetime', msg)
}

const updateAllInfo = async () => {
  await Promise.all([
    handleFetchUnassessedCount(),
    // handleFetchTokenUseToday(),
    // handleFetchTokenUseLast10Minutes(),
    handleFetchTokensAllTime(),
  ])
}

export const startInfoUpdater = () => {
  // Fetch immediately
  void updateAllInfo()

  // Set up interval to update every minute
  updateInterval = setInterval(() => {
    void updateAllInfo()
  }, 60 * 1000)
}

export const stopInfoUpdater = () => {
  if (updateInterval) {
    clearInterval(updateInterval)
    updateInterval = null
  }
}

// Export individual fetch functions in case they're needed elsewhere
export {
  handleFetchTokensAllTime,
  // handleFetchTokenUseLast10Minutes,
  // handleFetchTokenUseToday,
  handleFetchUnassessedCount,
  updateAllInfo,
}
