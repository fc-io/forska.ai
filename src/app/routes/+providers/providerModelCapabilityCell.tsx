import {createSignal, type JSX, Show, splitProps} from 'solid-js'

import {
  type ProviderModelBooleanCapability,
  type ProviderModelCapabilities,
  type ProviderModelContextWindowCapability,
} from '../+admin/+models/providerConnectionsClient.ts'
import {ProviderModelCapabilityEditor} from './providerModelCapabilityCell/providerModelCapabilityEditor.tsx'
import {
  formatProviderModelBooleanCapability,
  formatProviderModelContextWindow,
  getProviderModelCapabilitySourceLabel,
} from './providerModelCapabilityCell/providerModelCapabilityFormat.ts'

type CapabilityProvenance = Pick<ProviderModelContextWindowCapability, 'source' | 'sourceUrl' | 'verifiedAt'>

const UnverifiedBadge = () => {
  return (
    <span class="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-amber-800">
      Unverified
    </span>
  )
}

const CapabilitySource = (props: {capability: CapabilityProvenance}) => {
  return (
    <Show
      when={props.capability.sourceUrl}
      fallback={<span class="text-gray-500">{getProviderModelCapabilitySourceLabel(props.capability)}</span>}
    >
      {(sourceUrl) => {
        return (
          <a class="text-gray-500 underline" href={sourceUrl()} rel="noreferrer" target="_blank">
            {getProviderModelCapabilitySourceLabel(props.capability)}
          </a>
        )
      }}
    </Show>
  )
}

const CapabilityRow = (props: {children: JSX.Element; label: string}) => {
  return (
    <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span class="font-medium text-gray-700">{props.label}</span>
      {props.children}
    </div>
  )
}

const BooleanCapabilityValue = (props: {capability: ProviderModelBooleanCapability | null | undefined}) => {
  return (
    <Show when={props.capability} fallback={<UnverifiedBadge />}>
      {(capability) => {
        return (
          <>
            <span class="text-gray-900">{formatProviderModelBooleanCapability(capability())}</span>
            <CapabilitySource capability={capability()} />
          </>
        )
      }}
    </Show>
  )
}

export const ProviderModelCapabilityCell = (props: {
  capabilities: ProviderModelCapabilities | null
  modelId: string | null
  onSaved: () => Promise<unknown>
}) => {
  const [local] = splitProps(props, ['capabilities', 'modelId', 'onSaved'])
  const [isEditing, setIsEditing] = createSignal(false)

  return (
    <div class="space-y-1 text-xs">
      <CapabilityRow label="Context">
        <Show when={local.capabilities?.contextWindow} fallback={<UnverifiedBadge />}>
          {(contextWindow) => {
            return (
              <>
                <span class="text-gray-900">{formatProviderModelContextWindow(contextWindow())}</span>
                <CapabilitySource capability={contextWindow()} />
              </>
            )
          }}
        </Show>
      </CapabilityRow>
      <CapabilityRow label="Images">
        <BooleanCapabilityValue capability={local.capabilities?.supportsImageInput} />
      </CapabilityRow>
      <CapabilityRow label="PDF">
        <BooleanCapabilityValue capability={local.capabilities?.supportsPdfInput} />
      </CapabilityRow>
      <Show when={local.modelId} fallback={<p class="text-gray-500">Save the model to set capability overrides.</p>}>
        {(modelId) => {
          return (
            <Show
              when={isEditing()}
              fallback={
                <button
                  class="text-xs font-medium text-blue-600 hover:underline"
                  onClick={() => {
                    return setIsEditing(true)
                  }}
                  type="button"
                >
                  Edit capabilities
                </button>
              }
            >
              <ProviderModelCapabilityEditor
                capabilities={local.capabilities}
                modelId={modelId()}
                onClose={() => {
                  return setIsEditing(false)
                }}
                onSaved={local.onSaved}
              />
            </Show>
          )
        }}
      </Show>
    </div>
  )
}
