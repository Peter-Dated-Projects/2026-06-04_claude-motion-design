---
id: dynamodb-schema
root: architecture
type: architecture
status: current
summary: "DynamoDB single-table schema for motion design projects, conversation history, and animation versions, with S3 pointers for code storage."
created: 2026-06-04
updated: 2026-06-04
---

# DynamoDB Schema: Motion Design App

## Research Decisions

### 1. Single-table vs Multi-table

**Recommendation: Single-table design.**

Rationale:
- All 7 access patterns share a common partition root (user or project). Single-table collapses this into one `GetItem` or `Query` call per pattern rather than multiple table round-trips.
- The entity set is small and stable (Project, ProjectVersion, Conversation, Message). There is no cross-entity join complexity that would benefit from separate tables.
- Single-table avoids managing multiple table ARNs, separate billing dimensions, and separate GSI sets.
- The hierarchical relationship (User -> Project -> Conversation -> Message, and User -> Project -> ProjectVersion) maps cleanly onto a PK/SK hierarchy.

Tradeoff: single-table key design is harder to read initially and harder to debug without a schema doc. This document serves as that reference.

---

### 2. Animation Code: Inline vs S3

**Recommendation: S3 pointer for animation code; inline for all other attributes.**

- Remotion/animation component code files can easily exceed 400 KB for complex scenes. DynamoDB's maximum item size is 400 KB total, so large animation code will hard-fail at the SDK level.
- Even below the limit, large items degrade Query throughput (RCU cost is per KB consumed).
- Store the code blob in S3 at a deterministic key (`projects/{projectId}/versions/{versionId}/code.tsx`). Store the S3 key as `codeS3Key` in DynamoDB. The current live code is also stored this way on the Project item.
- Metadata (timestamps, author, change summary) stays inline — these are small and are the fields that list/filter operations need.

---

### 3. Version Retention Policy

**Recommendation: Keep the last 50 versions per project; delete older versions on write.**

- On each `SaveVersion` call, after writing the new version, run a `Query` with `ScanIndexForward=false` (newest first), `Limit=51`. If the result count is 51, delete the oldest item.
- This is a "bounded tail trim" — O(1) deletes, no batch scan needed.
- Alternatively, use DynamoDB TTL on version items (set `expiresAt` = now + 90 days) as a secondary cleanup. TTL is eventually consistent so it should not be the sole enforcement mechanism.
- Do not use TTL alone — it fires hours to days after expiry, so without the count-based trim you can accumulate many expired-but-not-yet-deleted items.

---

### 4. Conversation as an Append-Only Log

- Use a monotonic sort key based on a timestamp + random suffix to avoid hot-partition collisions: `MSG#{ISO8601_UTC}#{nanoid(6)}`.
- `Query` with `ScanIndexForward=true` returns messages in chronological order (full conversation replay).
- `Query` with `ScanIndexForward=false, Limit=N` returns the last N messages (resuming context window).
- Do not use a counter as the SK — counters require a conditional put or a separate atomic counter item, adding latency and complexity.

---

### 5. Bun + TypeScript Client Library

**Recommendation: ElectroDB.**

- **ElectroDB** (`electrodb`) is TypeScript-first, wraps AWS SDK v3 (`@aws-sdk/client-dynamodb` + `@aws-sdk/lib-dynamodb`), and works with Bun out of the box.
- It provides a model layer (entity definitions, type-safe queries) without the ORM overhead of DynamoDB-Mapper or Dynamoose.
- It enforces single-table patterns natively: each entity defines its own PK/SK template, and the library handles marshalling.
- **Avoid Dynamoose** — it targets the older AWS SDK v2 style and has known Bun incompatibilities via `require('aws-sdk')`.
- **Raw DocumentClient** is fine for simple apps but becomes verbose quickly when managing multiple entity types in a single table. ElectroDB is worth the dependency for this schema.

Install:
```
bun add electrodb @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb
```

---

## Table Definition

**Table name:** `motion-design` (one table for all environments; prefix item PKs with `{env}#` if sharing across envs, or use separate tables per env — separate tables are simpler for IAM isolation).

### Primary Key

| Attribute | Type | Role |
|-----------|------|------|
| `PK` | String | Partition key |
| `SK` | String | Sort key |

### Global Secondary Indexes

| GSI | PK | SK | Purpose |
|-----|----|----|---------|
| `GSI1` | `GSI1PK` | `GSI1SK` | List projects for a user sorted by updatedAt |

### TTL Attribute

`expiresAt` (Number, Unix epoch seconds) — set on ProjectVersion items for secondary cleanup.

---

## Entity Item Shapes

### Project

Represents a single motion design project belonging to a user.

```
PK:  USER#{userId}
SK:  PROJECT#{projectId}

GSI1PK: USER#{userId}
GSI1SK: PROJ#UPDATED#{updatedAt_ISO8601}  // e.g. PROJ#UPDATED#2026-06-04T12:00:00Z

Attributes:
  projectId:    string   // KSUID or UUID
  userId:       string
  name:         string
  createdAt:    string   // ISO 8601 UTC
  updatedAt:    string   // ISO 8601 UTC
  codeS3Key:    string   // S3 key for current animation code
  codeVersion:  string   // projectVersionId of the current live version
  entityType:   "Project"
```

Access patterns served:
- **List all projects for a user** — `Query GSI1` with `GSI1PK = USER#{userId}`, `ScanIndexForward=false` (newest updated first).
- **Get project by id** — `GetItem PK=USER#{userId}, SK=PROJECT#{projectId}` (requires userId in scope; if not available, add a GSI2 keyed on `projectId`).
- **Get current animation code** — `GetItem` same as above, then fetch `codeS3Key` from S3.

---

### ProjectVersion

Immutable snapshot of animation code at a point in time.

```
PK:  PROJECT#{projectId}
SK:  VERSION#{createdAt_ISO8601}#{versionId}
     // e.g. VERSION#2026-06-04T12:00:00Z#01J3...

Attributes:
  versionId:    string
  projectId:    string
  createdAt:    string   // ISO 8601 UTC
  codeS3Key:    string   // S3 key for this snapshot's code
  summary:      string   // optional human/AI-generated change summary (<=500 chars)
  expiresAt:    number   // Unix epoch; set to now + 90 days for TTL cleanup
  entityType:   "ProjectVersion"
```

Access patterns served:
- **List version history for a project** — `Query PK=PROJECT#{projectId}`, SK begins_with `VERSION#`, `ScanIndexForward=false`.
- **Save a new version** — `PutItem`, then trim oldest versions if count > 50 (see retention policy above).

---

### Conversation

Metadata record for the chat thread associated with a project. There is exactly one Conversation per Project (1:1). If a future requirement adds multiple conversations per project, add a `conversationId` and adjust the SK.

```
PK:  PROJECT#{projectId}
SK:  CONVERSATION#META

Attributes:
  projectId:    string
  createdAt:    string
  updatedAt:    string
  messageCount: number   // maintained by atomic counter on each append (optional; useful for pagination estimates)
  entityType:   "Conversation"
```

This item is used to confirm the conversation exists and store top-level metadata. It is not strictly required if you query messages directly, but makes `GetItem` for conversation-level metadata O(1).

---

### Message

Individual chat message in a conversation.

```
PK:  PROJECT#{projectId}
SK:  MSG#{createdAt_ISO8601}#{nanoid6}
     // e.g. MSG#2026-06-04T12:00:05.123Z#aB3kZ9

Attributes:
  messageId:    string   // same as the nanoid6 suffix, or a full KSUID
  projectId:    string
  role:         "user" | "assistant"
  content:      string   // message text; for large assistant responses consider a size guard
  codeDiff:     string?  // optional unified diff or new code block (if role="assistant")
  createdAt:    string   // ISO 8601 UTC
  entityType:   "Message"
```

Access patterns served:
- **Get full conversation history** — `Query PK=PROJECT#{projectId}`, SK begins_with `MSG#`, `ScanIndexForward=true`.
- **Get last N messages** — `Query` same, `ScanIndexForward=false, Limit=N`, then reverse client-side.
- **Append a new message** — `PutItem`; no conditions needed (SK includes a random suffix, so collisions are astronomically unlikely).

Note: if `content` or `codeDiff` can exceed ~300 KB per item, store them in S3 and keep only a `contentS3Key` inline. For typical chat messages this is not necessary, but keep it in mind for large assistant code dumps.

---

## Access Pattern Summary

| # | Pattern | Operation | Key expression |
|---|---------|-----------|----------------|
| 1 | List projects for user (sorted by updatedAt) | Query GSI1 | `GSI1PK = USER#{userId}`, SK desc |
| 2 | Get project by id | GetItem | `PK=USER#{userId}, SK=PROJECT#{projectId}` |
| 3 | Get current animation code | GetItem + S3 fetch | Same as #2, read `codeS3Key` |
| 4 | List version history for a project | Query | `PK=PROJECT#{projectId}`, SK begins_with `VERSION#`, desc |
| 5 | Get full conversation history | Query | `PK=PROJECT#{projectId}`, SK begins_with `MSG#`, asc |
| 6 | Append message to conversation | PutItem | `PK=PROJECT#{projectId}`, `SK=MSG#{ts}#{rand}` |
| 7 | Save a new version (code snapshot) | PutItem + trim | `PK=PROJECT#{projectId}`, `SK=VERSION#{ts}#{versionId}` |

---

## ElectroDB Entity Sketches (TypeScript)

```typescript
import { Entity, Service } from "electrodb";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";

const client = new DynamoDBClient({ region: process.env.AWS_REGION });
const table = process.env.DYNAMODB_TABLE!; // "motion-design"

const Project = new Entity(
  {
    model: { entity: "Project", version: "1", service: "motion" },
    attributes: {
      userId:      { type: "string", required: true },
      projectId:   { type: "string", required: true },
      name:        { type: "string", required: true },
      createdAt:   { type: "string", default: () => new Date().toISOString() },
      updatedAt:   { type: "string", default: () => new Date().toISOString() },
      codeS3Key:   { type: "string", required: true },
      codeVersion: { type: "string" },
    },
    indexes: {
      byUser: {
        pk: { field: "PK", composite: ["userId"] },
        sk: { field: "SK", composite: ["projectId"] },
      },
      byUserUpdated: {
        index: "GSI1",
        pk: { field: "GSI1PK", composite: ["userId"] },
        sk: { field: "GSI1SK", composite: ["updatedAt", "projectId"] },
      },
    },
  },
  { client, table }
);

const ProjectVersion = new Entity(
  {
    model: { entity: "ProjectVersion", version: "1", service: "motion" },
    attributes: {
      projectId:  { type: "string", required: true },
      versionId:  { type: "string", required: true },
      createdAt:  { type: "string", default: () => new Date().toISOString() },
      codeS3Key:  { type: "string", required: true },
      summary:    { type: "string" },
      expiresAt:  { type: "number" },
    },
    indexes: {
      byProject: {
        pk: { field: "PK", composite: ["projectId"] },
        sk: { field: "SK", composite: ["createdAt", "versionId"] },
      },
    },
  },
  { client, table }
);

const Message = new Entity(
  {
    model: { entity: "Message", version: "1", service: "motion" },
    attributes: {
      projectId:  { type: "string", required: true },
      messageId:  { type: "string", required: true },
      role:       { type: "string", required: true }, // "user" | "assistant"
      content:    { type: "string", required: true },
      codeDiff:   { type: "string" },
      createdAt:  { type: "string", default: () => new Date().toISOString() },
    },
    indexes: {
      byProject: {
        pk: { field: "PK", composite: ["projectId"] },
        sk: { field: "SK", composite: ["createdAt", "messageId"] },
      },
    },
  },
  { client, table }
);
```

---

## IaC Reference (AWS CDK v2 sketch)

```typescript
import { Table, AttributeType, BillingMode, ProjectionType } from "aws-cdk-lib/aws-dynamodb";

const table = new Table(stack, "MotionDesign", {
  tableName: "motion-design",
  partitionKey: { name: "PK", type: AttributeType.STRING },
  sortKey:      { name: "SK", type: AttributeType.STRING },
  billingMode:  BillingMode.PAY_PER_REQUEST,
  timeToLiveAttribute: "expiresAt",
});

table.addGlobalSecondaryIndex({
  indexName:            "GSI1",
  partitionKey:         { name: "GSI1PK", type: AttributeType.STRING },
  sortKey:              { name: "GSI1SK", type: AttributeType.STRING },
  projectionType:       ProjectionType.ALL,
});
```

---

## S3 Bucket Layout

```
s3://motion-design-code/
  projects/{projectId}/
    current/
      code.tsx                          // always the live version (overwritten on save)
    versions/{versionId}/
      code.tsx                          // immutable snapshot
```

S3 lifecycle rule: expire `versions/` objects older than 90 days (aligns with DynamoDB TTL policy).

---

## Open Questions / Future Considerations

- **Multi-conversation per project**: if added, replace `CONVERSATION#META` with `CONVERSATION#{conversationId}` and `MSG#{conversationId}#{ts}#{rand}`. The GSI1 pattern does not change.
- **Project sharing / collaboration**: would require a second GSI or a separate SharedProject edge item (`PK=USER#{granteeId}, SK=SHARED#PROJECT#{projectId}`) to support listing shared projects for a user.
- **Content size guard**: if average assistant messages with embedded code exceed ~200 KB, add a middleware layer that transparently offloads `content` to S3 and stores a `contentS3Key` pointer inline, similar to the animation code pattern.
- **Session storage**: handled by T-005 (Google OAuth + session schema). Session items live in the same table under `PK=SESSION#{sessionId}, SK=META`.
