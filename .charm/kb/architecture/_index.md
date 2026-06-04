# Architecture

How the system is actually built -- components, data flow, the mental model.

_No notes yet. Add atomic notes in this directory and list each one in the table below
(see `../CONTRIBUTING.md`)._

| Note | Summary | Status |
|---|---|---|
| [dynamodb-schema.md](../dynamodb-schema.md) | Single-table DynamoDB schema for projects, versions, conversations, and messages; S3 for animation code blobs. | current |
| [backend-architecture.md](../backend-architecture.md) | Bun + TypeScript monolith: Elysia framework, manual DI container with 3-environment swapping, bun:test for unit/integration, SSE for Claude streaming. | current |
| [export-rendering-pipeline.md](../export-rendering-pipeline.md) | Cost/complexity matrix and recommended v0 export strategy for MP4, GIF, and code export from a Remotion-based motion design tool. | current |
| [client-side-rendering.md](../client-side-rendering.md) | WebCodecs + mp4-muxer makes client-side 1080x1920 MP4 feasible for canvas-rendered compositions; DOM/CSS Remotion compositions remain blocked on frame capture, not encoding. | current |
