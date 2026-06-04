# Architecture

How the system is actually built -- components, data flow, the mental model.

_No notes yet. Add atomic notes in this directory and list each one in the table below
(see `../CONTRIBUTING.md`)._

| Note | Summary | Status |
|---|---|---|
| [dynamodb-schema.md](../dynamodb-schema.md) | Single-table DynamoDB schema for projects, versions, conversations, and messages; S3 for animation code blobs. | current |
| [backend-architecture.md](../backend-architecture.md) | Bun + TypeScript monolith: Elysia framework, manual DI container with 3-environment swapping, bun:test for unit/integration, SSE for Claude streaming. | current |
