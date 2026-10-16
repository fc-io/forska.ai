import {Show} from 'solid-js'

import {Button} from '../../../components/ui/button.tsx'
import {type ClaudeCodeStatus, type ProviderConnection} from '../+admin/+models/providerConnectionsClient.ts'

export type ClaudeCodeLoginCardProps = {
  authError: string
  canCreateProvider: boolean
  existingConnection: ProviderConnection | null
  isChecking: boolean
  isCreating: boolean
  message: string | null
  onCreate: () => void
  onRecheck: () => void
  status: ClaudeCodeStatus | null
}

const getStatusClass = (ok: boolean | undefined) => {
  return ok ? 'text-green-700' : 'text-amber-700'
}

const getCliLabel = (status: ClaudeCodeStatus | null) => {
  return status?.cliAvailable ? `Found (v${status.version ?? 'unknown'})` : 'Not found'
}

const getLoginLabel = (status: ClaudeCodeStatus | null) => {
  return status?.loggedIn
    ? `Logged in as ${status.email ?? 'unknown account'} (${status.subscriptionType ?? 'unknown plan'})`
    : 'Not logged in'
}

export const ClaudeCodeLoginCard = (props: ClaudeCodeLoginCardProps) => {
  return (
    <div class="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
      <h2 class="text-lg font-semibold text-gray-900">Claude Code Login</h2>
      <p class="mt-1 text-sm text-gray-500">
        Runs judgments through the local <span class="font-mono">claude</span> CLI with your claude.ai subscription.
      </p>
      <div class="mt-4 space-y-3 text-sm text-gray-700">
        <Show when={props.isChecking}>
          <p class="text-gray-500">Checking Claude Code status...</p>
        </Show>
        <Show when={props.status}>
          <div>
            <span class="font-medium">CLI:</span>{' '}
            <span class={getStatusClass(props.status?.cliAvailable)}>{getCliLabel(props.status)}</span>
          </div>
          <div>
            <span class="font-medium">Login:</span>{' '}
            <span class={getStatusClass(props.status?.loggedIn)}>{getLoginLabel(props.status)}</span>
          </div>
          <p class="break-all font-mono text-xs text-gray-500">{props.status?.binPath}</p>
        </Show>
        <Show when={props.message}>
          <p class="text-xs text-gray-500">{props.message}</p>
        </Show>

        <Show when={props.status && !props.status.loggedIn}>
          <div class="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
            Run <span class="font-mono">claude</span> in a terminal, use <span class="font-mono">/login</span> with your
            claude.ai account, then re-check.
          </div>
        </Show>

        <Show when={props.existingConnection}>
          <div class="rounded-md border border-green-200 bg-green-50 p-4 text-sm text-green-800">
            Claude Code is already added. Manage it on the Providers page.
          </div>
        </Show>

        <Show when={props.authError}>
          <p class="text-sm text-red-600">{props.authError}</p>
        </Show>

        <div class="flex flex-wrap gap-2">
          <Button
            disabled={props.isChecking}
            onClick={() => {
              props.onRecheck()
            }}
            variant="outline"
          >
            {props.isChecking ? 'Checking...' : 'Re-check'}
          </Button>
          <Show when={props.canCreateProvider}>
            <Button
              disabled={props.isCreating}
              onClick={() => {
                props.onCreate()
              }}
            >
              {props.isCreating ? 'Creating Provider...' : 'Create Provider'}
            </Button>
          </Show>
        </div>
      </div>
    </div>
  )
}
