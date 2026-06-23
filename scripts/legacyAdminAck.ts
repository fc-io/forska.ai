export const legacyLargeRebuildAckValue = 'legacy-large-rebuild'
export const legacyDirtyRefreshAckValue = 'legacy-dirty-refresh'

const getArgValue = (name: string) => {
  const argument = process.argv.slice(2).find((candidate) => {
    return candidate.startsWith(`${name}=`)
  })

  return argument?.slice(argument.indexOf('=') + 1).trim()
}

export const hasLegacyAdminAck = (expectedAck: string) => {
  return getArgValue('--legacy-admin-ack') === expectedAck || process.env.FORSKA_LEGACY_ADMIN_ACK === expectedAck
}

export const requireLegacyAdminAck = (input: {command: string; expectedAck: string}) => {
  if (hasLegacyAdminAck(input.expectedAck)) {
    return true
  }

  console.error(
    JSON.stringify({
      command: input.command,
      requiredAck: input.expectedAck,
      status: 'blocked_legacy_admin_ack_required',
    }),
  )
  process.exitCode = 1

  return false
}
