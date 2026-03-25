import {ApiKeyProviderForm, type ApiKeyProviderFormProps} from './apiKeyProviderForm.tsx'

export const GoogleProviderForm = (props: ApiKeyProviderFormProps) => {
  return <ApiKeyProviderForm {...props} apiKeyLabel={props.apiKeyLabel ?? 'Gemini API Key'} />
}
