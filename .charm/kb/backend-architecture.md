---
id: backend-architecture
root: architecture
type: architecture
status: current
summary: "Bun + TypeScript monolith: Elysia framework, manual DI container with 3-environment swapping, bun:test for unit/integration, SSE for Claude streaming."
created: 2026-06-04
updated: 2026-06-04
---

# Backend Architecture: Bun + TypeScript Monolith

## HTTP Framework: Elysia (recommended)

**Recommendation: Elysia over Hono or native Bun.serve.**

| | Elysia | Hono | Bun.serve (native) |
|---|---|---|---|
| TypeScript DX | End-to-end type inference, Eden treaty client | Good, manual schema validation | None out of box |
| Performance | Fastest on Bun benchmarks (Bun-native design) | Fast (runs on multiple runtimes) | Fastest theoretically, zero overhead |
| Middleware | Plugin ecosystem, lifecycle hooks | Middleware chain, smaller ecosystem | DIY everything |
| WebSocket / SSE | Built-in, typed | Built-in | Built-in via Bun.serve |
| Maturity | v1+, active, Bun-first | v4+, stable, runtime-agnostic | Stable but low-level |

Elysia is built specifically for Bun, delivers full end-to-end TypeScript type inference between server and client (via Eden treaty), and has a first-class plugin model for auth, swagger, CORS, and rate limiting. The DX advantage over Hono is significant: route handler return types flow automatically to the client without codegen. Native Bun.serve is fine for tiny microservices but requires too much boilerplate for a feature-rich monolith.

**Elysia basics:**

```ts
import { Elysia, t } from 'elysia'

const app = new Elysia()
  .get('/health', () => ({ ok: true }))
  .post('/projects', ({ body }) => createProject(body), {
    body: t.Object({ name: t.String(), description: t.Optional(t.String()) })
  })
  .listen(3000)

export type App = typeof app  // Eden treaty uses this for client types
```

---

## Dependency Injection: Manual Container (no decorators)

**Recommendation: manual container pattern over tsyringe/inversify/awilix.**

tsyringe and inversify require `experimentalDecorators` and `reflect-metadata`, which adds complexity and doesn't play cleanly with Bun's strict ESM handling. awilix is runtime-agnostic and decorator-free but adds indirection for limited gain on a monolith this size. A manual container is:

- Zero dependencies
- Fully typed (each binding is a concrete interface, not a string key)
- Trivial to swap implementations per environment
- Readable: the wiring is just a function that returns a plain object

### Container pattern

```ts
// src/container/types.ts
export interface IUserRepository {
  findById(id: string): Promise<User | null>
  create(user: CreateUserInput): Promise<User>
}

export interface IAnthropicService {
  streamCompletion(prompt: string): AsyncIterable<string>
}

export interface IProjectRepository {
  findByOwner(userId: string): Promise<Project[]>
  create(input: CreateProjectInput): Promise<Project>
}

export interface Container {
  userRepository: IUserRepository
  projectRepository: IProjectRepository
  conversationRepository: IConversationRepository
  anthropicService: IAnthropicService
  authService: AuthService
  projectService: ProjectService
  conversationService: ConversationService
  renderService: RenderService
}
```

```ts
// src/container/index.ts
import { buildDevContainer } from './dev'
import { buildTestContainer } from './test'
import { buildProdContainer } from './prod'

export function buildContainer(): Container {
  const env = process.env.NODE_ENV ?? 'development'
  if (env === 'test') return buildTestContainer()
  if (env === 'production') return buildProdContainer()
  return buildDevContainer()
}
```

### Production container (real DynamoDB + real Anthropic)

```ts
// src/container/prod.ts
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import Anthropic from '@anthropic-ai/sdk'
import { DynamoUserRepository } from '../repositories/dynamo/UserRepository'
import { DynamoProjectRepository } from '../repositories/dynamo/ProjectRepository'
import { AnthropicServiceImpl } from '../services/AnthropicService'
import { ProjectService } from '../services/ProjectService'
// ... other imports

export function buildProdContainer(): Container {
  const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION })
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const userRepository = new DynamoUserRepository(dynamo)
  const projectRepository = new DynamoProjectRepository(dynamo)
  const conversationRepository = new DynamoConversationRepository(dynamo)
  const anthropicService = new AnthropicServiceImpl(anthropic)

  const authService = new AuthService(userRepository)
  const projectService = new ProjectService(projectRepository, authService)
  const conversationService = new ConversationService(
    conversationRepository, projectRepository, anthropicService
  )
  const renderService = new RenderService()

  return {
    userRepository, projectRepository, conversationRepository,
    anthropicService, authService, projectService,
    conversationService, renderService
  }
}
```

### Test container (in-memory stores + mock Anthropic)

```ts
// src/container/test.ts
import { InMemoryUserRepository } from '../repositories/memory/UserRepository'
import { InMemoryProjectRepository } from '../repositories/memory/ProjectRepository'
import { MockAnthropicService } from '../services/mocks/AnthropicService'
// ...

export function buildTestContainer(): Container {
  const userRepository = new InMemoryUserRepository()
  const projectRepository = new InMemoryProjectRepository()
  const conversationRepository = new InMemoryConversationRepository()
  const anthropicService = new MockAnthropicService()

  const authService = new AuthService(userRepository)
  const projectService = new ProjectService(projectRepository, authService)
  const conversationService = new ConversationService(
    conversationRepository, projectRepository, anthropicService
  )
  const renderService = new RenderService()

  return {
    userRepository, projectRepository, conversationRepository,
    anthropicService, authService, projectService,
    conversationService, renderService
  }
}
```

### Dev container

Dev uses real DynamoDB against a local DynamoDB Local instance (Docker) or real AWS with a dev table prefix. Same structure as prod, just different env vars / table names.

```ts
// src/container/dev.ts
// Same as prod but DynamoDBClient points to localhost:8000 (DynamoDB Local)
// Table names prefixed with "dev_" from env var TABLE_PREFIX
export function buildDevContainer(): Container {
  const dynamo = new DynamoDBClient({
    region: 'us-east-1',
    endpoint: process.env.DYNAMO_ENDPOINT ?? 'http://localhost:8000',
  })
  // ... rest identical to prod
}
```

### Wiring into Elysia

```ts
// src/index.ts
import { Elysia } from 'elysia'
import { buildContainer } from './container'
import { projectRoutes } from './routes/projects'
import { conversationRoutes } from './routes/conversations'

const container = buildContainer()

const app = new Elysia()
  .use(projectRoutes(container))
  .use(conversationRoutes(container))
  .listen(process.env.PORT ?? 3000)
```

Each route module receives the container as a parameter and destructures what it needs. No global state, easy to test.

---

## Test Strategy: bun:test

**Recommendation: bun:test for everything — unit, integration, and e2e.**

bun:test is production-ready as of Bun v1.0+. It ships a Jest-compatible API (`describe`, `it`/`test`, `expect`, `beforeEach`, `afterEach`, `mock`, `spyOn`) so migration from Jest is straightforward. Key advantages:

- Zero config: no tsconfig jest transforms, no babel, no esbuild plugins
- ~20-40x faster than Jest for a TS project (no transpile step — Bun runs TS natively)
- `bun:test` mock module support via `mock.module()` handles import mocking without Jest's `jest.mock()` hoisting magic
- Watch mode: `bun test --watch`

**Known limitations:**
- `mock.module()` (ESM module mocking) was stabilized in Bun 1.1; pin Bun >= 1.1.0
- Some Jest matchers (`toMatchSnapshot` file snapshots) have minor behavioral differences; avoid snapshot tests for now
- Bun test parallelism is per-file; within a file, tests run serially

### Example: unit test for ProjectService

```ts
// src/services/__tests__/ProjectService.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { ProjectService } from '../ProjectService'
import { InMemoryProjectRepository } from '../../repositories/memory/ProjectRepository'
import { AuthService } from '../AuthService'
import { InMemoryUserRepository } from '../../repositories/memory/UserRepository'

describe('ProjectService', () => {
  let service: ProjectService
  let repo: InMemoryProjectRepository

  beforeEach(() => {
    const userRepo = new InMemoryUserRepository()
    const authService = new AuthService(userRepo)
    repo = new InMemoryProjectRepository()
    service = new ProjectService(repo, authService)
  })

  it('creates a project and returns it with an id', async () => {
    const project = await service.create({
      ownerId: 'user-1',
      name: 'My Animation',
      description: 'Test'
    })
    expect(project.id).toBeString()
    expect(project.name).toBe('My Animation')
    expect(project.ownerId).toBe('user-1')
  })

  it('returns only the calling user\'s projects', async () => {
    await service.create({ ownerId: 'user-1', name: 'A', description: '' })
    await service.create({ ownerId: 'user-2', name: 'B', description: '' })
    const projects = await service.listByOwner('user-1')
    expect(projects).toHaveLength(1)
    expect(projects[0].name).toBe('A')
  })
})
```

### Example: integration test with real container swap

```ts
// src/__tests__/projects.integration.test.ts
import { describe, it, expect } from 'bun:test'
import { Elysia } from 'elysia'
import { buildTestContainer } from '../container/test'
import { projectRoutes } from '../routes/projects'

const container = buildTestContainer()
const app = new Elysia().use(projectRoutes(container))

describe('POST /projects', () => {
  it('creates a project and returns 201', async () => {
    const res = await app.handle(
      new Request('http://localhost/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': 'user-1' },
        body: JSON.stringify({ name: 'Test Project' })
      })
    )
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.id).toBeString()
  })
})
```

Elysia's `.handle()` method accepts a raw `Request` and returns a `Response` — no running server needed for integration tests. This is a first-class pattern in Elysia, analogous to `supertest` in Express.

---

## Streaming Claude Responses: SSE (recommended over WebSocket)

**Recommendation: Server-Sent Events (SSE) over WebSocket for Claude streaming.**

| | SSE | WebSocket |
|---|---|---|
| Direction | Server -> client only | Bidirectional |
| Protocol | HTTP/1.1 (or HTTP/2) | Upgraded TCP |
| Reconnect | Automatic (browser built-in) | Manual |
| Auth | Standard HTTP headers/cookies | Needs custom handshake |
| Proxying | Works through most CDNs/load balancers | Requires sticky sessions or WS-aware proxy |
| Bun support | Native via `Response` + `ReadableStream` | Native via `Bun.serve` `websocket:` option |
| Elysia support | Native via `new Response(stream)` | Elysia `ws()` plugin |

SSE is the right choice because:
1. Claude streaming is inherently server-to-client (tokens flowing one way)
2. SSE reconnects automatically if the connection drops — important for long generations
3. No extra proxy config; works through Vercel, Cloudflare, AWS ALB without WS upgrade
4. Simpler: one endpoint, standard fetch API on the client

WebSocket is only justified if the client also needs to interrupt generation mid-stream (cancel). This can alternatively be done with a separate DELETE endpoint and an `AbortController` on the server side, keeping SSE for the stream itself.

### SSE implementation with Elysia + Anthropic streaming

```ts
// src/routes/conversations.ts
import { Elysia, t } from 'elysia'
import type { Container } from '../container/types'

export function conversationRoutes(container: Container) {
  const { conversationService } = container

  return new Elysia({ prefix: '/conversations' })
    .post('/:id/stream', async ({ params, body, set }) => {
      const { id } = params
      const { message } = body

      set.headers['Content-Type'] = 'text/event-stream'
      set.headers['Cache-Control'] = 'no-cache'
      set.headers['Connection'] = 'keep-alive'

      const stream = new ReadableStream({
        async start(controller) {
          try {
            for await (const chunk of conversationService.streamResponse(id, message)) {
              const data = `data: ${JSON.stringify({ token: chunk })}\n\n`
              controller.enqueue(new TextEncoder().encode(data))
            }
            controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
          } catch (err) {
            const errData = `data: ${JSON.stringify({ error: String(err) })}\n\n`
            controller.enqueue(new TextEncoder().encode(errData))
          } finally {
            controller.close()
          }
        }
      })

      return new Response(stream)
    }, {
      params: t.Object({ id: t.String() }),
      body: t.Object({ message: t.String() })
    })
}
```

```ts
// src/services/AnthropicService.ts
import Anthropic from '@anthropic-ai/sdk'
import type { IAnthropicService } from '../container/types'

export class AnthropicServiceImpl implements IAnthropicService {
  constructor(private client: Anthropic) {}

  async *streamCompletion(systemPrompt: string, userMessage: string): AsyncIterable<string> {
    const stream = this.client.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }]
    })

    for await (const event of stream) {
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        yield event.delta.text
      }
    }
  }
}
```

### Client-side consumption (Next.js)

```ts
const response = await fetch(`/api/conversations/${id}/stream`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ message })
})

const reader = response.body!.getReader()
const decoder = new TextDecoder()

while (true) {
  const { done, value } = await reader.read()
  if (done) break
  const lines = decoder.decode(value).split('\n')
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      const data = line.slice(6)
      if (data === '[DONE]') return
      const { token } = JSON.parse(data)
      appendToken(token) // update React state
    }
  }
}
```

---

## Monolith Structure: Layered (recommended)

**Recommendation: layered architecture over feature modules for this project size.**

Feature modules (vertical slices) are best when teams own separate domains. For a solo or small team on a motion design tool with ~5 services, layered is cleaner: all repositories together, all services together, all routes together. This avoids the "where does cross-feature logic go?" problem that bites vertical slices early.

```
src/
  container/
    index.ts          # buildContainer() entry point
    types.ts          # all interface definitions
    dev.ts
    test.ts
    prod.ts
  repositories/
    dynamo/
      UserRepository.ts
      ProjectRepository.ts
      ConversationRepository.ts
    memory/           # in-memory implementations for tests
      UserRepository.ts
      ProjectRepository.ts
      ConversationRepository.ts
  services/
    AuthService.ts
    ProjectService.ts
    ConversationService.ts
    AnthropicService.ts
    RenderService.ts
    mocks/
      AnthropicService.ts   # MockAnthropicService for tests
  routes/
    auth.ts
    projects.ts
    conversations.ts
    render.ts
  middleware/
    session.ts        # validates session cookie, injects userId into context
    error.ts          # global error handler
    logger.ts
  index.ts            # app entry point, builds container, mounts routes
```

### Middleware pattern with Elysia

```ts
// src/middleware/session.ts
import { Elysia } from 'elysia'
import type { Container } from '../container/types'

export function sessionMiddleware(container: Container) {
  return new Elysia({ name: 'session' })
    .derive(async ({ request, set }) => {
      const sessionId = getCookieFromRequest(request, 'session_id')
      if (!sessionId) {
        set.status = 401
        throw new Error('Unauthorized')
      }
      const user = await container.authService.validateSession(sessionId)
      if (!user) {
        set.status = 401
        throw new Error('Session expired')
      }
      return { user }
    })
}

// Usage in route:
// new Elysia().use(sessionMiddleware(container)).get('/me', ({ user }) => user)
```

---

## Service / Repository Layer Summary

| Layer | Classes | Responsibilities |
|---|---|---|
| Routes | `auth.ts`, `projects.ts`, `conversations.ts`, `render.ts` | HTTP parsing, validation, calling services, SSE streams |
| Services | `AuthService`, `ProjectService`, `ConversationService`, `AnthropicService`, `RenderService` | Business logic, orchestration, no HTTP/DB concerns |
| Repositories | `UserRepository`, `ProjectRepository`, `ConversationRepository` | DynamoDB access, item marshalling/unmarshalling |
| Container | `buildContainer()` + env-specific builders | Wires the layers together, swaps implementations per env |
| Middleware | `session`, `error`, `logger` | Cross-cutting concerns, injected via Elysia plugins |

---

## Key Constraints and Gotchas

- **Bun >= 1.1.0 required** for stable `mock.module()` ESM mocking in bun:test.
- **No `reflect-metadata`**: don't use tsyringe or inversify — they require it and it's awkward in Bun's strict ESM mode.
- **Elysia's `.handle()` for tests**: avoids spinning up a real port; Elysia handles `Request -> Response` in-process.
- **SSE and HTTP/2**: Bun supports HTTP/2 but Elysia's SSE works on HTTP/1.1 by default. For prod behind a load balancer (ALB), ensure connection draining is configured to avoid mid-stream termination.
- **AbortController for stream cancellation**: pass an `AbortSignal` into `anthropic.messages.stream()` to stop generation when the client disconnects. Wire via `request.signal` in Elysia.
- **DynamoDB Local for dev**: run `docker run -p 8000:8000 amazon/dynamodb-local` and set `DYNAMO_ENDPOINT=http://localhost:8000`. Use `TABLE_PREFIX=dev_` to namespace tables away from prod.
- **tsconfig**: set `"moduleResolution": "bundler"` and `"target": "ESNext"` for Bun. Do not use `"module": "CommonJS"` — Bun is ESM-native.
