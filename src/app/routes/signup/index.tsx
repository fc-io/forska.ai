import {createFileRoute} from '@tanstack/solid-router'

import {authClient} from '../../lib/auth-client'

const RouteComponent = () => {
  return (
    <div>
      <div>Hello "/signup/" ordinary user!</div>
      <div>
        <button
          onClick={() => {
            void authClient.signUp.email({
              email: 'test@test.com',
              password: 'testtesttest',
              name: 'test',
            })
            // .then(() => {
            //   console.log('signed up')
            // })
          }}
        >
          Sign up ordinary user
        </button>
      </div>
      <div>
        <button
          onClick={() => {
            void authClient.admin.createUser({
              email: 'user@example.com',
              password: 'some-secure-password',
              name: 'James Smith',
              role: 'user',
              data: {customField: 'customValue'},
            })
          }}
        >
          Create User (using admin)
        </button>
      </div>
    </div>
  )
}

export const Route = createFileRoute('/signup/')({component: RouteComponent})
