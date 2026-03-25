import {ApiKeyProviderForm, type ApiKeyProviderFormProps} from './apiKeyProviderForm.tsx'

export const AnthropicProviderForm = (props: ApiKeyProviderFormProps) => {
  return <ApiKeyProviderForm {...props} apiKeyLabel={props.apiKeyLabel ?? 'Anthropic API Key'} />
}
