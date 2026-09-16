// @vitest-environment happy-dom

import {createSignal} from 'solid-js'
import {render} from 'solid-js/web'
import {afterEach, describe, expect, test, vi} from 'vitest'

vi.mock('../../../../services/apiClient.ts', () => {
  return {
    apiClient: {
      api: {
        datasources: () => {
          return {
            tracking: {
              changes: {
                get: async () => {
                  return {data: {data: {items: []}}}
                },
              },
              reconcile: {
                post: async () => {
                  return {data: {success: true}}
                },
              },
            },
          }
        },
      },
    },
  }
})

const renderTrackingOptions = async (params: {dateFrom: string; importRoute: string}) => {
  const {TrackingOptionsField} = await import('./-trackingControls.tsx')
  const [trackingEnabled, setTrackingEnabled] = createSignal(false)
  const [scheduleMonths, setScheduleMonths] = createSignal([3, 12, 24, 36])
  const container = document.createElement('div')
  document.body.appendChild(container)
  const dispose = render(() => {
    return (
      <TrackingOptionsField
        id="tracking-option-test"
        dateFrom={() => {
          return params.dateFrom
        }}
        importRoute={() => {
          return params.importRoute
        }}
        trackingEnabled={trackingEnabled}
        onTrackingEnabledChange={setTrackingEnabled}
        scheduleMonths={scheduleMonths}
        onScheduleMonthsChange={setScheduleMonths}
      />
    )
  }, container)

  await Promise.resolve()

  return {container, dispose, trackingEnabled}
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('data source tracking options', () => {
  test('enables tracking for supported built-in routes with a start date', async () => {
    const {container, dispose, trackingEnabled} = await renderTrackingOptions({
      dateFrom: '2026-01-01',
      importRoute: '/api/datasources/import/pubmed',
    })

    try {
      const checkbox = container.querySelector<HTMLInputElement>('#tracking-option-test')

      expect(checkbox).toBeInstanceOf(HTMLInputElement)
      expect(checkbox?.disabled).toBe(false)
      expect(container.textContent).toContain('Track new provider windows continuously from the configured start date.')

      if (checkbox) {
        checkbox.checked = true
        checkbox.dispatchEvent(new Event('change', {bubbles: true}))
      }

      expect(trackingEnabled()).toBe(true)
      expect(container.textContent).toContain('Reconciliation schedule')
      expect(container.textContent).toContain('3 months')
      expect(container.textContent).toContain('36 months')
    } finally {
      dispose()
      container.remove()
    }
  })

  test('disables tracking for unsupported built-in routes', async () => {
    const {container, dispose} = await renderTrackingOptions({
      dateFrom: '2026-01-01',
      importRoute: '/api/datasources/import/arxiv',
    })

    try {
      const checkbox = container.querySelector<HTMLInputElement>('#tracking-option-test')

      expect(checkbox).toBeInstanceOf(HTMLInputElement)
      expect(checkbox?.disabled).toBe(true)
      expect(container.textContent).toContain(
        'Continuous tracking is only available for PubMed and Europe PMC PPR built-in routes in this slice.',
      )
    } finally {
      dispose()
      container.remove()
    }
  })

  test('disables tracking when the supported route has no start date', async () => {
    const {container, dispose} = await renderTrackingOptions({
      dateFrom: '',
      importRoute: '/api/datasources/import/europe-pmc-ppr',
    })

    try {
      const checkbox = container.querySelector<HTMLInputElement>('#tracking-option-test')

      expect(checkbox).toBeInstanceOf(HTMLInputElement)
      expect(checkbox?.disabled).toBe(true)
      expect(container.textContent).toContain(
        'Set Date From before enabling continuous tracking; tracking needs a start boundary.',
      )
    } finally {
      dispose()
      container.remove()
    }
  })
})
