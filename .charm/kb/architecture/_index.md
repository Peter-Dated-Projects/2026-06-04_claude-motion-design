# Architecture

How the system is actually built -- components, data flow, the mental model.

| Note | Summary | Status |
|---|---|---|
| [dynamodb-schema.md](../dynamodb-schema.md) | Single-table DynamoDB schema for projects, versions, conversations, and messages; S3 for animation code blobs. | current |
| [backend-architecture.md](../backend-architecture.md) | Bun + TypeScript monolith: Elysia framework, manual DI container with 3-environment swapping, bun:test for unit/integration, SSE for Claude streaming. | current |
| [export-rendering-pipeline.md](../export-rendering-pipeline.md) | Cost/complexity matrix and recommended v0 export strategy for MP4, GIF, and code export from a Remotion-based motion design tool. | current |
| [client-side-rendering.md](../client-side-rendering.md) | WebCodecs + mp4-muxer makes client-side 1080x1920 MP4 feasible for canvas-rendered compositions; DOM/CSS Remotion compositions remain blocked on frame capture, not encoding. | current |
| [frontend-backend-sync.md](../frontend-backend-sync.md) | Recommended sync strategy between Next.js frontend and Elysia backend after Claude editing sequences: server-side persist-before-DONE, optimistic preview, Zustand + localStorage safety net. | current |
| [replay-controls.md](../replay-controls.md) | Remotion Player programmatic control API, custom replay controls via postMessage, loop/speed/frame-step, auto-replay UX, filmstrip verdict, and phone-bezel approach for the 1080x1920 preview panel. | current |
| [claude-code-webapp.md](../claude-code-webapp.md) | Whether embedding a local Claude Code session in a browser is feasible, how it works, and a comparison to the simpler Elysia-backend API-key approach for the motion design app. | current |
| [frontend-options-and-local-claude.md](../frontend-options-and-local-claude.md) | Ranked evaluation of all six frontend delivery options (browser app, sidecar, VS Code extension, Tauri, Electron, Claude Desktop Extension) with concrete Claude CLI + Skills + MCP wiring for each. | current |
| [terraform-aws-infra.md](../terraform-aws-infra.md) | Minimal AWS infra for the motion design Tauri app: Terraform recommendation over CDK, complete HCL for DynamoDB+S3+KMS+IAM, near-zero cost estimate, KMS-overkill verdict, Fly.io backend recommendation, and Remotion Lambda deferral rationale. | current |
| [preview-sandbox.md](preview-sandbox.md) | Live preview pipeline: a worker esbuild-transforms TSX to an IIFE, injected via blob-URL script into a sandboxed iframe that mounts @remotion/player off locally-bundled, fully-offline React + Remotion window globals. | current |
