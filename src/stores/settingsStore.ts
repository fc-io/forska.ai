// store.ts
import {
  // endOfWeek,
  // startOfMonth,
  startOfWeek,
  // subMonths,
  subWeeks,
} from 'date-fns'
import {createStore} from 'solid-js/store'

interface SettingsState {
  fromDate: Date
  toDate: Date
  batchSize: number
}

export const [state, setState] = createStore<SettingsState>({
  fromDate: startOfWeek(subWeeks(new Date(), 1), {weekStartsOn: 1}),
  // fromDate: new Date('2024-12-30'),

  // toDate: endOfWeek(subWeeks(new Date(), 1), {weekStartsOn: 1}),
  // toDate: new Date('2025-08-01'),
  toDate: new Date(),
  batchSize: 100,
})
