import {type} from 'arktype'

// Usage statistics for token consumption
const UsageType = type({
  promptTokens: 'number',
  completionTokens: 'number',
  totalTokens: 'number',
  'prompt_tokens_details?': 'null',
})

const BodyUsageType = type({
  prompt_tokens: 'number',
  completion_tokens: 'number',
  total_tokens: 'number',
  'prompt_tokens_details?': 'null',
})

// Headers object for HTTP responses
const HeadersType = type({'content-length': 'string', 'content-type': 'string'})

// Message content structure
const MessageContentType = type({type: "'text'", text: 'string'})

// Assistant message structure
const AssistantMessageType = type({
  role: "'assistant'",
  content: type('string').or(type(MessageContentType.array())),
  id: 'string',
  'tool_calls?': 'unknown[]',
  'reasoning_content?': 'string',
})

// Choice structure from completion response
const ChoiceType = type({
  index: 'number',
  message: {role: "'assistant'", content: 'string', 'tool_calls?': 'unknown[]', 'reasoning_content?': 'string'},
  'logprobs?': 'null',
  finish_reason: 'string',
  'stop_reason?': 'null',
})

// Response body structure
const ResponseBodyType = type({
  id: 'string',
  object: 'string',
  created: 'number',
  model: 'string',
  choices: type(ChoiceType.array()),
  usage: type(BodyUsageType),
  'prompt_logprobs?': 'null',
  'kv_transfer_params?': 'null',
})

// Complete response structure
const ResponseType = type({
  id: 'string',
  timestamp: 'Date',
  modelId: 'string',
  headers: type(HeadersType),
  body: type(ResponseBodyType),
  messages: type(AssistantMessageType.array()),
})

// Request structure
const RequestType = type({body: 'string'})

// Provider metadata structure
const ProviderMetadataType = type({openai: 'object'})

// Step structure in the steps array
const StepType = type({
  stepType: 'string',
  text: 'string',
  reasoningDetails: 'unknown[]',
  files: 'unknown[]',
  sources: 'unknown[]',
  toolCalls: 'unknown[]',
  toolResults: 'unknown[]',
  finishReason: 'string',
  usage: type(UsageType),
  warnings: 'unknown[]',
  request: type(RequestType),
  response: type(ResponseType),
  'providerMetadata?': type(ProviderMetadataType),
  'experimental_providerMetadata?': type(ProviderMetadataType),
  'isContinued?': 'boolean',
})

// Main AI response type
const AIResponseType = type({
  text: 'string',
  files: 'unknown[]',
  reasoningDetails: 'unknown[]',
  toolCalls: 'unknown[]',
  toolResults: 'unknown[]',
  finishReason: 'string',
  usage: type(UsageType),
  warnings: 'unknown[]',
  request: type(RequestType),

  response: type(ResponseType),
  steps: type(StepType.array()),

  experimental_providerMetadata: type(ProviderMetadataType),
  providerMetadata: type(ProviderMetadataType),
  sources: 'unknown[]',
  //   body: type(ResponseBodyType),
})

// Export the inferred TypeScript type
type AIResponse = typeof AIResponseType.infer

// Export individual types that might be useful
type Usage = typeof UsageType.infer
// Note: Removed unused type exports to fix lint errors

// import { type } from "arktype";
// import { AIResponseType, type AIResponse } from "../types/ai-response.js";

// Example usage of the AIResponse schema
const validateAIResponse = (data: unknown): AIResponse => {
  // Parse and validate the data
  const result = AIResponseType(data)

  if (result instanceof type.errors) {
    throw new Error(`Validation failed: ${result.summary}`)
  }

  return result
}

// Example function to safely access properties
const extractTokenUsage = (response: AIResponse) => {
  return {
    promptTokens: response.usage.promptTokens,
    completionTokens: response.usage.completionTokens,
    totalTokens: response.usage.totalTokens,
  }
}

// Example function to get the main response text
const getResponseText = (response: AIResponse): string => {
  return response.text
}

// Example function to get all assistant messages
const getAssistantMessages = (response: AIResponse) => {
  return response.response.messages.filter((msg) => {
    return msg.role === 'assistant'
  })
}

const parseModelResponse = (response: unknown): AIResponse => {
  try {
    return AIResponseType.assert(response)
  } catch (error) {
    console.error('Error parsing AI response:', error)
    throw error
  }
}

// Consolidated exports
export {
  type AIResponse,
  AIResponseType,
  extractTokenUsage,
  getAssistantMessages,
  getResponseText,
  parseModelResponse,
  type Usage,
  validateAIResponse,
}
