// info.ts
import {createStore} from 'solid-js/store'

interface InfoState {
  unassessedCount: number | null
  tokenUseToday: string
  tokenUseLast10Minutes: string
  tokenUseLifetime: string
  lastUpdated: Date | null
}

export const [infoState, setInfoState] = createStore<InfoState>({
  unassessedCount: null,
  tokenUseToday: '',
  tokenUseLast10Minutes: '',
  tokenUseLifetime: '',
  lastUpdated: null,
})
