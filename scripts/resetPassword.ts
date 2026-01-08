import {hashPassword} from 'better-auth/crypto'

const email = process.argv[2]
const newPassword = process.argv[3]

if (!email || !newPassword) {
  console.error('Usage: bun scripts/resetPassword.ts <email> <newPassword>')
  process.exit(1)
}

const hash = await hashPassword(newPassword)
console.log(`Password hash for ${email}:`)
console.log(hash)
console.log('')
console.log('Run this SQL to update:')
console.log(`UPDATE account SET password = '${hash}' WHERE user_id = (SELECT id FROM "user" WHERE email = '${email}');`)
