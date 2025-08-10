import {createFileRoute} from '@tanstack/solid-router'

const About = () => {
  return <div class="p-2">Hello from About!</div>
}

export const Route = createFileRoute('/about/')({component: About})
