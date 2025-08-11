import {createSignal, type JSX, Show} from 'solid-js'
import {produce} from 'solid-js/store'

// import {run} from '../../agent.ts'
// import {runAgentHarvest} from '../../agent_harvest.ts'
// import {startArxivHarvest} from '../../agent/startArxivHarvest.ts'
import {setState, state} from '../../stores/settingsStore.ts'
import {SettingsPanel} from './subheader/subheaderSettingsPanel.tsx'

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
export const Subheader = (): JSX.Element => {
  const [isRunning, setIsRunning] = createSignal(false)
  const [isAgentRunning, setIsAgentRunning] = createSignal(false)
  const [isSettingsOpen, setIsSettingsOpen] = createSignal(false)

  const handleArxivHarvest = async () => {
    if (isRunning()) {
      return
    }
    setIsRunning(true)
    // try {
    //   await startArxivHarvest({
    //     ...CONFIG,
    //     fromDate: state.fromDate.toISOString(),
    //     toDate: state.toDate.toISOString(),
    //     maxResults: state.batchSize,
    //   })
    // } finally {
    //   setIsRunning(false)
    // }
  }

  const handleRunAgent = async () => {
    if (isAgentRunning()) {
      return
    }
    setIsAgentRunning(true)
    // try {
    //   await run(state.batchSize, state.fromDate, state.toDate)
    // } finally {
    //   setIsAgentRunning(false)
    // }
  }
  return (
    <div class="space-y-4">
      <div class="flex justify-end space-x-2">
        <button class="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-10 items-center justify-center whitespace-nowrap rounded-md px-4 py-2 text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50">
          Harvest PubMed Articles
        </button>
        <button
          onClick={() => {
            void handleArxivHarvest()
          }}
          disabled={isRunning()}
          class="relative bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-10 items-center justify-center whitespace-nowrap rounded-md px-4 py-2 text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
        >
          <span classList={{'opacity-0': isRunning()}}>
            Harvest Arxiv Articles
          </span>
          <Show when={isRunning()}>
            <div class="absolute inset-0 flex items-center justify-center">
              <svg
                class="animate-spin h-5 w-5 text-white"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  class="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  stroke-width="4"
                />
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
            void handleRunAgent()
          }}
          disabled={isAgentRunning()}
          class="relative bg-green-600 text-white hover:bg-green-700 inline-flex h-10 items-center justify-center whitespace-nowrap rounded-md px-4 py-2 text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
        >
          <span classList={{'opacity-0': isAgentRunning()}}>Run Agent</span>
          <Show when={isAgentRunning()}>
            <div class="absolute inset-0 flex items-center justify-center">
              <svg
                class="animate-spin h-5 w-5 text-white"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  class="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  stroke-width="4"
                />
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
          class="border-input bg-background hover:bg-accent hover:text-accent-foreground inline-flex h-10 items-center justify-center whitespace-nowrap rounded-md border px-4 py-2 text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
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
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M19 9l-7 7-7-7"
            />
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
