import {expect, test} from 'bun:test'

import {
  getClaudeCodeOnboardingUiState,
  getCodexOnboardingUiState,
  getConnectionApiKeyUiState,
} from './providerUiState.ts'

const claudeCodeStatus = {
  authMethod: 'claude.ai',
  binPath: '/opt/homebrew/bin/claude',
  cliAvailable: true,
  email: 'me@example.com',
  loggedIn: true,
  message: 'Claude Code 2.1.300 logged in as me@example.com (max).',
  subscriptionType: 'max',
  version: '2.1.300',
}

test('claude code onboarding state allows creating a connection once the CLI is logged in', () => {
  const state = getClaudeCodeOnboardingUiState({
    existingClaudeCodeConnection: null,
    providerAuth: {
      message: claudeCodeStatus.message,
      payload: {authMode: 'claude-cli', providerState: claudeCodeStatus},
      status: 'complete',
    },
    providerKind: 'claude-code',
  })

  expect(state).toEqual({canCreateProvider: true, shouldHideConnectCard: true})
})

test('claude code onboarding state blocks creation while the CLI is logged out', () => {
  const state = getClaudeCodeOnboardingUiState({
    existingClaudeCodeConnection: null,
    providerAuth: {
      message: 'Claude Code 2.1.300 is not logged in.',
      payload: {authMode: 'claude-cli', providerState: {...claudeCodeStatus, loggedIn: false}},
      status: 'unsupported',
    },
    providerKind: 'claude-code',
  })

  expect(state).toEqual({canCreateProvider: false, shouldHideConnectCard: true})
})

test('claude code onboarding state leaves other providers untouched', () => {
  expect(
    getClaudeCodeOnboardingUiState({existingClaudeCodeConnection: null, providerAuth: null, providerKind: 'openai'}),
  ).toEqual({canCreateProvider: false, shouldHideConnectCard: false})
})

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
