import {createFileRoute} from '@tanstack/solid-router'

import {authClient} from '../../lib/auth-client'

const RouteComponent = () => {
  return (
    <div>
      <div>Hello "/signup/"!</div>
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
          Sign up
        </button>
      </div>
    </div>
  )
}

export const Route = createFileRoute('/signup/')({component: RouteComponent})
