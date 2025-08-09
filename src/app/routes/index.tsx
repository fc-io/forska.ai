import {createFileRoute} from '@tanstack/solid-router'

import {authClient} from '../lib/auth-client'

const Index = () => {
  return (
    <div class="p-2">
      <h3>Welcome Home!</h3>
    </div>
  )
}

export const Route = createFileRoute('/')({component: Index})
