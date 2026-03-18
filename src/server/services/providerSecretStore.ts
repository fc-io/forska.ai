const providerSecretKeychainService = 'ai.forska.provider-connection'
const providerSecretKeychainPrefix = 'keychain:provider-connection:'
const providerSecretEnvPrefix = 'env:'

const getTrimmedValue = (value: string | null | undefined): string | null => {
  const normalized = String(value ?? '').trim()

  return normalized === '' ? null : normalized
}

const readProcessOutput = async (stream: ReadableStream<Uint8Array> | null): Promise<string> => {
  return stream ? new Response(stream).text() : ''
}

const runSecurityCommand = async (args: string[]): Promise<string> => {
  const child = globalThis.Bun.spawn(['security', ...args], {stderr: 'pipe', stdout: 'pipe'})
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    readProcessOutput(child.stdout),
    readProcessOutput(child.stderr),
  ])
  const trimmedStdout = stdout.trim()
  const trimmedStderr = stderr.trim()

  if (exitCode !== 0) {
    throw new Error(trimmedStderr || trimmedStdout || 'macOS keychain command failed')
  }

  return trimmedStdout
}

const getProviderSecretKeychainAccount = (connectionId: string): string => {
  return `provider-connection:${connectionId}`
}

const getProviderSecretRef = (connectionId: string): string => {
  return `${providerSecretKeychainPrefix}${connectionId}`
}

const getProviderSecretConnectionId = (secretRef: string): string | null => {
  return secretRef.startsWith(providerSecretKeychainPrefix)
    ? secretRef.slice(providerSecretKeychainPrefix.length)
    : null
}

const getProviderSecretEnvVar = (secretRef: string): string | null => {
  return secretRef.startsWith(providerSecretEnvPrefix)
    ? getTrimmedValue(secretRef.slice(providerSecretEnvPrefix.length))
    : null
}

const getProviderSecretFromEnv = (secretRef: string): string | null => {
  const envVarName = getProviderSecretEnvVar(secretRef)
  return envVarName ? getTrimmedValue(process.env[envVarName]) : null
}

const storeProviderSecretInKeychain = async ({
  connectionId,
  secret,
}: {
  connectionId: string
  secret: string
}): Promise<string> => {
  if (process.platform !== 'darwin') {
    throw new Error('Provider secret storage currently requires macOS keychain on this platform')
  }

  await runSecurityCommand([
    'add-generic-password',
    '-U',
    '-s',
    providerSecretKeychainService,
    '-a',
    getProviderSecretKeychainAccount(connectionId),
    '-w',
    secret,
  ])

  return getProviderSecretRef(connectionId)
}

const readProviderSecretFromKeychain = async (connectionId: string): Promise<string | null> => {
  if (process.platform !== 'darwin') {
    return null
  }

  try {
    return getTrimmedValue(
      await runSecurityCommand([
        'find-generic-password',
        '-s',
        providerSecretKeychainService,
        '-a',
        getProviderSecretKeychainAccount(connectionId),
        '-w',
      ]),
    )
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
    return message.includes('could not be found') ? null : Promise.reject(error)
  }
}

const deleteProviderSecretFromKeychain = async (connectionId: string): Promise<void> => {
  if (process.platform !== 'darwin') {
    return
  }

  try {
    await runSecurityCommand([
      'delete-generic-password',
      '-s',
      providerSecretKeychainService,
      '-a',
      getProviderSecretKeychainAccount(connectionId),
    ])
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
    if (!message.includes('could not be found')) {
      throw error
    }
  }
}

export const getProviderSecretValue = async (secretRef: string | null | undefined): Promise<string | null> => {
  const normalized = getTrimmedValue(secretRef)

  return !normalized
    ? null
    : normalized.startsWith(providerSecretEnvPrefix)
      ? getProviderSecretFromEnv(normalized)
      : getProviderSecretConnectionId(normalized)
        ? readProviderSecretFromKeychain(getProviderSecretConnectionId(normalized) as string)
        : null
}

export const storeProviderSecretValue = async ({
  connectionId,
  secret,
}: {
  connectionId: string
  secret: string
}): Promise<string> => {
  const normalizedSecret = getTrimmedValue(secret)

  if (!normalizedSecret) {
    throw new Error('Secret value is required')
  }

  return storeProviderSecretInKeychain({connectionId, secret: normalizedSecret})
}

export const deleteProviderSecretValue = async (secretRef: string | null | undefined): Promise<void> => {
  const normalized = getTrimmedValue(secretRef)
  const connectionId = normalized ? getProviderSecretConnectionId(normalized) : null

  return connectionId ? deleteProviderSecretFromKeychain(connectionId) : Promise.resolve()
}
