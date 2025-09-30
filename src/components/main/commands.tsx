import {createSignal, type JSX, Show} from 'solid-js'
import {produce} from 'solid-js/store'

import {startArxivHarvest} from '../../agent/startArxivHarvest.ts'
// import {runAgentHarvest} from '../../agent_harvest.ts'
import {setState, state} from '../../stores/settingsStore.ts'
import {SettingsPanel} from './commands/subheaderSettingsPanel.tsx'

const CONFIG = {
  searchTerm: 'agent', // the arxiv oai api don't support search terms
  maxResults: 99999, // basically ignored by the arxiv oai api
}

const setFromDate = (date: Date) => {
  console.log('setFromDate', date)

  setState(
    produce((s) => {
      s.fromDate = date
    }),
  )
}

const setToDate = (date: Date) => {
  console.log('setToDate', date)

  setState(
    produce((s) => {
      s.toDate = date
    }),
  )
}

const setNumberOfRequests = (batchSize: number) => {
  console.log('setNumberOfRequests', batchSize)
  setState(
    produce((s) => {
      s.batchSize = batchSize
    }),
  )
}
export const CommandPanel = (): JSX.Element => {
  const [isRunning, setIsRunning] = createSignal(false)
  const [isAgentRunning, setIsAgentRunning] = createSignal(false)
  const [isSettingsOpen, setIsSettingsOpen] = createSignal(false)

  const handleArxivHarvest = async () => {
    if (isRunning()) {
      return
    }
    setIsRunning(true)
    try {
      await startArxivHarvest({
        ...CONFIG,
        fromDate: state.fromDate.toISOString(),
        toDate: state.toDate.toISOString(),
        maxResults: state.batchSize,
      })
    } finally {
      setIsRunning(false)
    }
  }

  const handleRunAgent = async () => {
    if (isAgentRunning()) {
      return
    }
    setIsAgentRunning(true)
    try {
      await run(state.batchSize, state.fromDate, state.toDate)
    } finally {
      setIsAgentRunning(false)
    }
  }
  return (
    <div class="space-y-4">
      <div class="flex justify-end space-x-2">
        <button class="bg-blue-600 text-white hover:bg-blue-700 px-4 py-2 rounded-md text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed">
          Harvest PubMed Articles
        </button>
        <button
          onClick={() => {
            void handleArxivHarvest()
          }}
          disabled={isRunning()}
          class="relative bg-blue-600 text-white hover:bg-blue-700 inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <span classList={{'opacity-0': isRunning()}}>Harvest Arxiv Articles</span>
          <Show when={isRunning()}>
            <div class="absolute inset-0 flex items-center justify-center">
              <svg
                class="animate-spin h-5 w-5 text-white"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                <path
                  class="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
            </div>
          </Show>
        </button>
        <button
          onClick={() => {
            setIsSettingsOpen(!isSettingsOpen())
          }}
          class="border border-gray-300 bg-white hover:bg-gray-50 text-gray-900 inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Settings
          <svg
            class="ml-2 h-4 w-4 transition-transform duration-200"
            classList={{'rotate-180': isSettingsOpen()}}
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      </div>

      <SettingsPanel
        isOpen={isSettingsOpen()}
        onClose={() => {
          setIsSettingsOpen(false)
        }}
        numberOfRequests={state.batchSize}
        setNumberOfRequests={setNumberOfRequests}
        fromDate={state.fromDate}
        setFromDate={setFromDate}
        toDate={state.toDate}
        setToDate={setToDate}
      />
    </div>
  )
}
