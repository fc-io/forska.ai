import { Elysia } from "elysia";
import {cors} from '@elysiajs/cors'

const index = new Elysia().get("/", () => "Hello Elysia")
const test = new Elysia().get("/test", () => "test Elysia")
const app = new Elysia().use(cors()).use(index).use(test).listen(3000);

export type App = typeof app
console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`
);

// app.handle(new Request('http://localhost:3000/test')).then(console.log)`