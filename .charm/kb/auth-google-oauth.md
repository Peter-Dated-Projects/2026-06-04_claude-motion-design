---
id: auth-google-oauth
root: decisions
type: decision
status: current
summary: "Google OAuth with finks.ai domain restriction, NextAuth.js vs custom Bun flow assessment, JWT vs opaque tokens, and DynamoDB schema for users and sessions."
created: 2026-06-04
updated: 2026-06-04
---

## Google OAuth 2.0 — finks.ai Domain Restriction

### The `hd` parameter

Google's OAuth 2.0 authorization endpoint accepts an `hd` (hosted domain) parameter that pre-filters the account picker to a G Suite / Google Workspace domain:

```
https://accounts.google.com/o/oauth2/v2/auth
  ?client_id=CLIENT_ID
  &redirect_uri=REDIRECT_URI
  &response_type=code
  &scope=openid email profile
  &hd=finks.ai
```

**Critical:** `hd` is a UX hint only. A malicious user can strip it from the URL and sign in with any Google account. You must validate the `hd` claim server-side after exchanging the code for tokens.

### Server-side validation

After the authorization code exchange, Google returns an ID token (JWT). Decode it and check:

```typescript
import { OAuth2Client } from 'google-auth-library';

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

async function verifyGoogleIdToken(idToken: string) {
  const ticket = await client.verifyIdToken({
    idToken,
    audience: process.env.GOOGLE_CLIENT_ID,
  });
  const payload = ticket.getPayload();

  if (!payload) throw new Error('Empty token payload');
  if (payload.hd !== 'finks.ai') {
    throw new Error(`Unauthorized domain: ${payload.hd}`);
  }

  return {
    googleId: payload.sub,
    email: payload.email!,
    name: payload.name!,
    hd: payload.hd,
  };
}
```

Key fields in the ID token payload: `sub` (stable Google user ID), `email`, `name`, `hd` (hosted domain). Always verify `hd === 'finks.ai'` — never trust it from the query string.

### OAuth scopes

Minimum viable:
- `openid` — required for OIDC ID token
- `email` — `email` + `email_verified` claims
- `profile` — `name`, `picture` claims

Do not request drive, calendar, or other scopes unless explicitly needed; the consent screen grows and approval takes longer for Workspace admins.

---

## NextAuth.js vs Custom Bun OAuth Flow

### NextAuth.js

**Pros:**
- Zero-boilerplate Google provider with built-in `hd` validation hook
- Handles PKCE, state parameter, CSRF cookies automatically
- Works with Next.js App Router and has a DynamoDB adapter (`@auth/dynamodb-adapter`)
- Session serialization/deserialization managed by the library

**Cons:**
- Designed for Next.js — runs as a Next.js API route. The Bun backend (separate process) cannot use it directly; it would be a client to the Next.js session
- Dual session stores: NextAuth owns the session, but your Bun API also needs to authenticate requests. You'd either proxy all auth checks through Next.js or duplicate session lookup in Bun
- `@auth/dynamodb-adapter` uses its own table schema — less control over the shape
- Version fragmentation: NextAuth v4 vs Auth.js v5 have different APIs; v5 is still beta as of mid-2025

**When it makes sense:** If Next.js serves both the UI and the API (API routes handle everything). Then NextAuth owns auth end-to-end and the Bun backend is not involved in user-facing flows.

### Custom OAuth flow in Bun

**Pros:**
- Single source of truth: Bun issues and validates all session tokens
- Full control over DynamoDB schema and session lifecycle
- No library version fragmentation
- The Next.js frontend calls the Bun API for auth just like any other endpoint

**Cons:**
- Must implement PKCE, state validation, and CSRF protection yourself (~150-200 lines)
- Must keep `google-auth-library` updated as Google rotates public keys

### Recommendation

**Custom flow in Bun.** The architecture has a dedicated Bun backend as the API layer — routing auth through Next.js API routes and then re-validating in Bun creates two auth planes. A single Bun-owned OAuth flow with DynamoDB sessions is cleaner. The implementation surface is small and well-understood.

The only reason to prefer NextAuth.js is if you collapse Next.js and the Bun backend into a single Next.js server-side process. Given the current separation, custom Bun is the right call.

---

## JWT vs Opaque Session Tokens

### JWT (signed tokens)

**Pros:**
- Stateless: the Bun API can validate a token without a database roundtrip (verify signature + expiry)
- Good for short-lived tokens (15-60 min access tokens)
- Carries claims inline (userId, email, role) — no lookup needed for common assertions

**Cons:**
- Cannot be revoked without a blocklist (which re-introduces state anyway)
- If the signing secret leaks, all outstanding tokens are compromised
- Refresh token rotation requires careful storage — browser `httpOnly` cookie for the refresh token, in-memory for access token
- Token size grows with claims (adds ~200-400 bytes to every request header)

### Opaque session tokens

**Pros:**
- Can be revoked instantly by deleting the DynamoDB row
- No secret leakage risk beyond the token itself (which is a random string)
- Session state (device info, last seen, etc.) is in DynamoDB — easy to audit
- Token is small (a UUID or 32-byte hex string)

**Cons:**
- Every authenticated request requires a DynamoDB read (single-digit ms with DAX, ~1-5ms without)
- More complex refresh rotation (must update the row atomically)

### Recommendation for this app

**Opaque session tokens stored in DynamoDB.** This is an internal tool — revocability matters (employee offboarding), the user base is small (no throughput concern), and the DynamoDB read overhead is negligible at this scale. The extra complexity of JWT refresh rotation and blocklist management outweighs the stateless benefit here.

Use a single long-lived session token (7-30 days) with sliding expiry on activity, refreshed server-side. No separate access/refresh token pair needed for an internal app.

---

## DynamoDB Schema

### Users table

**Table name:** `motion-users`

| Attribute | Type | Role |
|---|---|---|
| `userId` | String (UUID v4) | Partition key (PK) |
| `email` | String | GSI PK (`email-index`) |
| `googleId` | String | GSI PK (`googleId-index`) |
| `name` | String | — |
| `createdAt` | String (ISO-8601) | — |
| `anthropicApiKey` | String (AES-256-GCM encrypted) | — |
| `isActive` | Boolean | — |

**GSIs:**

```
email-index:    PK = email      (for login lookup by email)
googleId-index: PK = googleId   (for first-time sign-in upsert)
```

No sort key on either GSI — each email and googleId is unique.

**Access patterns:**
- Sign-in: `GetItem` on `googleId-index` by `googleId` → returns userId + email
- Profile load: `GetItem` on PK (`userId`)
- API key store/retrieve: `UpdateItem` on PK to write/read `anthropicApiKey`

**Anthropic API key encryption:** Encrypt with AES-256-GCM using a KMS-derived data key before writing. Store `{ ciphertext, iv, tag }` as a JSON string in `anthropicApiKey`. Never log or return it in plaintext.

---

### Sessions table

**Table name:** `motion-sessions`

| Attribute | Type | Role |
|---|---|---|
| `sessionToken` | String (32-byte hex) | Partition key (PK) |
| `userId` | String (UUID) | GSI PK (`userId-index`) |
| `expiresAt` | Number (Unix epoch) | TTL attribute |
| `createdAt` | String (ISO-8601) | — |
| `lastSeenAt` | String (ISO-8601) | Updated on each request |
| `deviceInfo` | Map | `{ userAgent, ip }` |
| `isRevoked` | Boolean | Explicit revocation before TTL |

**GSIs:**

```
userId-index: PK = userId, SK = createdAt  (list all sessions for a user, sorted by creation)
```

**TTL:** Set `expiresAt` to `now + 30 days` on creation; slide it forward on each request (or every hour to reduce write amplification). DynamoDB deletes the item automatically within ~48 hours of expiry.

**Access patterns:**
- Auth middleware: `GetItem` on PK (`sessionToken`) — single read, check `isRevoked` and `expiresAt`
- List user sessions: `Query` on `userId-index` with `userId = :uid`, `createdAt > :cutoff`
- Revoke single session: `UpdateItem` to set `isRevoked = true`
- Revoke all sessions (offboarding): `Query` on `userId-index` + batch `UpdateItem` or delete

**Session token generation:**

```typescript
import { randomBytes } from 'crypto';

function generateSessionToken(): string {
  return randomBytes(32).toString('hex'); // 64-char hex string
}
```

---

## Session Middleware Sketch — Bun Backend

The Bun HTTP framework (e.g. Elysia.js or raw `Bun.serve`) handles all API routes. Auth middleware reads the session token from the `Authorization: Bearer <token>` header (or `session` httpOnly cookie), validates it against DynamoDB, and injects the resolved `User` into the request context.

### DI container pattern

```typescript
// src/container.ts
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SessionRepository } from './repos/session';
import { UserRepository } from './repos/user';

export interface Container {
  db: DynamoDBDocumentClient;
  sessions: SessionRepository;
  users: UserRepository;
}

export function buildContainer(): Container {
  const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION });
  const db = DynamoDBDocumentClient.from(dynamo);
  return {
    db,
    sessions: new SessionRepository(db),
    users: new UserRepository(db),
  };
}
```

### Auth middleware (Elysia example)

```typescript
// src/middleware/auth.ts
import Elysia from 'elysia';
import type { Container } from '../container';

export function authMiddleware(container: Container) {
  return new Elysia()
    .derive(async ({ request, set }) => {
      const token = extractToken(request);
      if (!token) {
        set.status = 401;
        throw new Error('Missing session token');
      }

      const session = await container.sessions.findByToken(token);
      if (!session || session.isRevoked || session.expiresAt < Date.now() / 1000) {
        set.status = 401;
        throw new Error('Invalid or expired session');
      }

      const user = await container.users.findById(session.userId);
      if (!user || !user.isActive) {
        set.status = 403;
        throw new Error('User not found or deactivated');
      }

      // Slide TTL (fire-and-forget, don't await)
      container.sessions.refreshExpiry(token).catch(() => {});

      return { user, session };
    });
}

function extractToken(request: Request): string | null {
  const auth = request.headers.get('Authorization');
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  // fallback: httpOnly cookie
  const cookie = request.headers.get('Cookie') ?? '';
  const match = cookie.match(/session=([^;]+)/);
  return match?.[1] ?? null;
}
```

### SessionRepository (DynamoDB reads)

```typescript
// src/repos/session.ts
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const TABLE = 'motion-sessions';

export class SessionRepository {
  constructor(private db: DynamoDBDocumentClient) {}

  async findByToken(token: string) {
    const result = await this.db.send(new GetCommand({
      TableName: TABLE,
      Key: { sessionToken: token },
    }));
    return result.Item ?? null;
  }

  async refreshExpiry(token: string) {
    const newExpiry = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60; // +30d
    await this.db.send(new UpdateCommand({
      TableName: TABLE,
      Key: { sessionToken: token },
      UpdateExpression: 'SET expiresAt = :exp, lastSeenAt = :now',
      ExpressionAttributeValues: {
        ':exp': newExpiry,
        ':now': new Date().toISOString(),
      },
    }));
  }
}
```

---

## Google Cloud Console Setup Checklist

1. Create a project in Google Cloud Console (or use an existing Workspace project).
2. Enable the **Google Identity** (formerly Google+ API / People API) — just `openid email profile` scopes; no additional APIs needed.
3. Under **Credentials** → **OAuth 2.0 Client IDs**: Application type = Web application.
4. Add authorized redirect URIs:
   - `http://localhost:3000/auth/callback` (dev)
   - `https://your-domain.com/auth/callback` (prod)
5. Under **OAuth consent screen**: set User Type = **Internal** (Workspace org only). This restricts sign-in to your Google Workspace domain without needing the `hd` parameter check — but still validate `hd` server-side for defense-in-depth.
6. Store `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in AWS Secrets Manager (or env); never commit them.

---

## Open Questions / Follow-up

- **KMS key management:** Where does the AES key for `anthropicApiKey` encryption live? AWS KMS with a per-environment CMK is the standard answer; confirm the AWS account structure first.
- **Session cookie vs Authorization header:** For the browser client (Next.js), an `httpOnly SameSite=Strict` cookie is more secure than a header (no JS access). The middleware above handles both; pick one consistently.
- **Multi-device policy:** Current schema allows unlimited active sessions per user. If single-device is required, add a `Query` + revoke step on the `userId-index` during sign-in.
- **Token rotation on use:** For higher-security deployments, rotate the session token on each request (exchange old token for new, delete old row). At internal-tool scale this is likely overkill, but worth noting.
