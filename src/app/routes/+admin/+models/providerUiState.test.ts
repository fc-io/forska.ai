import {expect, test} from 'bun:test'

import {getCodexOnboardingUiState, getConnectionApiKeyUiState} from './providerUiState.ts'

test('codex onboarding state hides generic connect card once Codex is already connected', () => {
  const state = getCodexOnboardingUiState({
    existingCodexConnection: null,
    providerAuth: {
      message: 'Codex connected',
      payload: {authMode: 'codex-cli', providerState: {appServerReady: true, cli: {loggedIn: true}}},
      status: 'complete',
    },
    providerKind: 'codex',
  })

  expect(state.shouldHideConnectCard).toBe(true)
  expect(state.canCreateProvider).toBe(true)
})

test('connection API key ui state marks sglang as optional and visible', () => {
  const state = getConnectionApiKeyUiState({hasSecret: false, providerKind: 'sglang'})

  expect(state.shouldShowField).toBe(true)
  expect(state.isOptional).toBe(true)
})

test('connection API key ui state hides codex API key field', () => {
  const state = getConnectionApiKeyUiState({hasSecret: false, providerKind: 'codex'})

  expect(state.shouldShowField).toBe(false)
  expect(state.isOptional).toBe(false)
})
