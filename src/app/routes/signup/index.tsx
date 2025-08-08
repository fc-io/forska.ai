import {createFileRoute} from '@tanstack/solid-router'

const RouteComponent = () => {
  return <div>Hello "/signup/"!</div>
}

export const Route = createFileRoute('/signup/')({component: RouteComponent})
