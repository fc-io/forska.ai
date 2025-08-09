import {auth} from '../auth'

const newUser = async () => {
  await auth.api.createUser({
    body: {
      email: 'user@example.com', // required
      password: 'password', // required
      name: 'James Smith', // required
      role: 'admin',
      data: {customField: 'customValue'},
    },
  })
}

await newUser()
