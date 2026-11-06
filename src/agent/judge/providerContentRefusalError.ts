export type ProviderContentRefusal = {
  failureCode: string
  modelName: string
  providerKind: string | null
  reason: string
  refusedAt: string
}

export class ProviderContentRefusalError extends Error {
  refusal: ProviderContentRefusal

  constructor(refusal: ProviderContentRefusal, {cause}: {cause?: unknown} = {}) {
    super(refusal.reason, {cause})
    this.name = 'ProviderContentRefusalError'
    this.refusal = refusal
  }
}
