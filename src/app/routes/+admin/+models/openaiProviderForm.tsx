import {ApiKeyProviderForm, type ApiKeyProviderFormProps} from './apiKeyProviderForm.tsx'

export const OpenaiProviderForm = (props: ApiKeyProviderFormProps) => {
  return <ApiKeyProviderForm {...props} apiKeyLabel={props.apiKeyLabel ?? 'OpenAI API Key'} />
}
