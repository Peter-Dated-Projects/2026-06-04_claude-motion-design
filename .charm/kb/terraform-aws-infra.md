---
id: terraform-aws-infra
root: architecture
type: architecture
status: current
summary: "Minimal AWS infra for the motion design Tauri app: Terraform recommendation over CDK, complete HCL for DynamoDB+S3+KMS+IAM, near-zero cost estimate, KMS-overkill verdict, Fly.io backend recommendation, and Remotion Lambda deferral rationale."
created: 2026-06-04
updated: 2026-06-04
---

# Minimal AWS Infrastructure for the Motion Design App

## TL;DR

Use **Terraform** (not CDK). Host the Elysia backend on **Fly.io** (not AWS) — that eliminates the need for EC2/Lambda and keeps the AWS footprint to DynamoDB + S3 + one KMS key. Total AWS cost at 2 users: **~$1.10/month** (almost entirely the KMS key). Skip KMS and the cost is near-zero. Remotion Lambda: defer — the client-side WebCodecs path is sufficient for v0 MP4 export.

---

## 1. Terraform vs CDK

**Use Terraform.**

| | Terraform | AWS CDK |
|---|---|---|
| Language | HCL (declarative) | TypeScript/Python (imperative) |
| State | Remote (S3 backend + DynamoDB lock) or local | Managed by CloudFormation |
| Solo-dev DX | Excellent — `plan` shows exactly what will change | Good, but CloudFormation change sets are slower and noisier |
| DynamoDB + S3 + KMS support | Mature, first-class resources | Also mature via CloudFormation |
| Community / docs | Largest IaC community; HashiCorp registry has copy-paste modules | Smaller community; AWS-authored but fewer third-party examples |
| Learning curve | Low for simple infra; HCL is readable without prior knowledge | Steeper — you need to know CDK constructs AND CloudFormation concepts |
| Lock-in | Terraform state is self-managed; easy to migrate or destroy | Locked to CloudFormation stacks; harder to surgically remove resources |

For 3 DynamoDB tables + 1 S3 bucket + 1 KMS key + IAM, Terraform is 100–150 lines of HCL. CDK would be similar in LoC but adds the CloudFormation abstraction layer, slower deploys, and a `cdk bootstrap` prerequisite. Terraform wins for a solo dev with minimal infra.

**State backend**: for 2 users on an internal tool, local state (`terraform.tfstate`) is fine to start. If you want durability, a free-tier S3 bucket + DynamoDB lock table is the standard pattern and costs near-zero.

---

## 2. Monthly Cost Estimate at 2 Users

### DynamoDB (PAY_PER_REQUEST, 3 tables)

Free tier: 25 GB storage, **25 WCU and 25 RCU provisioned** — but PAY_PER_REQUEST tables are **not covered by the free tier WCU/RCU allocation**. The free tier applies to provisioned tables only. PAY_PER_REQUEST pricing:

- Write: $1.25 per million write request units
- Read: $0.25 per million read request units
- Storage: $0.25/GB/month (first 25 GB is free)

At 2 users doing normal editing (estimate: 10,000 reads/day + 2,000 writes/day):
- Reads: 300,000/month × $0.25/million = **$0.075/month**
- Writes: 60,000/month × $1.25/million = **$0.075/month**
- Storage: well under 1 GB → **$0.00 (free tier)**

DynamoDB total: **~$0.15/month**

> Note: if you switch to provisioned capacity with 1 RCU + 1 WCU per table, all 3 tables together use 3 RCU + 3 WCU, comfortably within the free tier 25 RCU/25 WCU allowance. Cost becomes $0.00. The tradeoff is that PAY_PER_REQUEST handles spikier workloads without throttling. For 2 users, provisioned with 1 RCU/1 WCU per table is fine — but PAY_PER_REQUEST is simpler to manage (no capacity planning) and still only costs ~$0.15/month.

### S3 (animation code storage)

100 files × 10 KB = 1 MB total.

- Storage: first 5 GB is free → **$0.00**
- GET requests: 1,000/month × $0.0004/1000 = **$0.0004/month**
- PUT requests: 200/month × $0.005/1000 = **$0.001/month**

S3 total: **~$0.00/month** (well within free tier)

### KMS (1 CMK)

- 1 CMK: **$1.00/month flat** (no free tier for CMKs)
- API calls: first 20,000 requests/month are free; 2 users will never exceed this

KMS total: **$1.00/month**

### Grand Total

| Service | Monthly cost |
|---|---|
| DynamoDB | ~$0.15 |
| S3 | ~$0.00 |
| KMS | $1.00 |
| **Total** | **~$1.15/month** |

Without KMS: **~$0.15/month**

---

## 3. Is KMS Overkill?

**Yes, KMS is overkill for encrypting 2 API keys.**

The threat model: you're storing 2 Anthropic API keys in DynamoDB (one per user), encrypted so they can't be read if the DynamoDB table is compromised. Options:

| Approach | Cost | Complexity | Security |
|---|---|---|---|
| KMS CMK encrypt/decrypt in backend | $1/month | Medium — KMS API calls in Elysia service | High — keys never touch backend memory plaintext long |
| AWS Secrets Manager | $0.40/secret/month = $0.80 for 2 | Low — single API call to retrieve | High — rotation built in, but overkill for API keys |
| SSM Parameter Store (SecureString) | **Free** (standard tier, <10K API calls) | Low — similar to Secrets Manager | Good — KMS-backed but you don't manage the CMK |
| Envelope encryption with app-managed key | $0.00 | Medium — generate a data key, store encrypted in DynamoDB | Good if the master key is kept out of DynamoDB (e.g. in SSM) |
| DynamoDB encryption at rest (default) | **Free** — AWS-managed key | None — automatic | Adequate for most threat models; protects against physical disk compromise |

**Recommendation: use SSM Parameter Store SecureString (free tier) instead of a CMK.**

- Store each user's Anthropic API key as a SecureString in SSM (`/motion-design/users/{user_id}/anthropic_api_key`).
- SSM encrypts with an AWS-managed KMS key at no charge (standard parameters, <10K API calls/month).
- Elysia backend retrieves the key via `ssm:GetParameter` with `WithDecryption=true` on each request (or cache in-process for the session).
- No $1/month CMK charge. No KMS key management.
- If you later decide you need a CMK (e.g. key rotation on a schedule, audit trail per key), you can migrate SSM parameters to use a CMK without changing the DynamoDB schema.

**DynamoDB encryption at rest is automatic** (AWS-owned key, no cost, no config). The API keys stored in DynamoDB are encrypted on disk by default even without your own KMS key. The SSM approach adds a separate credential store so the plaintext key is never in DynamoDB at all — a cleaner separation.

---

## 4. Backend Hosting: Fly.io vs AWS

**Use Fly.io.** No EC2 or Lambda needed.

### Options

| | Fly.io | Railway | AWS Lambda | AWS EC2 (t3.micro) |
|---|---|---|---|---|
| Monthly cost (low traffic) | **$0–3/month** (free tier: 3 shared-cpu-1x 256 MB VMs) | $5/month hobby plan | ~$0/month (well within free tier) | ~$8.50/month (t3.micro, on-demand) |
| Elysia (Bun) support | Excellent — Dockerfile deploy | Excellent | Poor — Bun SSE streaming + Lambda cold starts conflict | Good |
| SSE streaming | Native — persistent connection | Native | Problematic — Lambda has 15 min max, response streaming is new and limited | Native |
| DynamoDB + SSM access | Via IAM role + access keys in env | Same | Via Lambda execution role (IAM) | Via EC2 instance role (IAM) |
| Ops overhead | Very low — `fly deploy` | Very low | Low but cold start tuning required | Medium — AMI, patches, SSH |
| AWS credential management | Access key + secret in fly secrets | Same | Native IAM (no long-lived creds) | Native IAM instance role |

Fly.io free tier: 3 shared-cpu-1x machines with 256 MB RAM. The Elysia backend at 2 users will fit in 256 MB easily. Estimated cost: **$0/month** on free tier.

**SSE streaming is the deciding factor against Lambda.** The Elysia backend streams Claude responses to the frontend via SSE. Lambda's response streaming is in preview, has a 1 MB/s limit, and conflicts with Bun's runtime. Fly.io keeps a persistent process and handles SSE natively.

**Does Fly.io eliminate the need for Terraform?** Almost. You still need Terraform (or manual setup) for:
- DynamoDB tables
- S3 bucket
- SSM parameters (or set manually via AWS console)
- IAM user with minimal policy for Fly.io to call DynamoDB/S3/SSM

Fly.io itself is configured via `fly.toml` (not Terraform), but there is a Terraform provider (`registry.terraform.io/providers/fly-apps/fly`) if you want everything in one IaC layer. For 2 users, managing Fly.io via CLI and AWS resources via Terraform is cleaner than mixing providers.

---

## 5. Remotion Lambda: Provision Now or Defer?

**Defer.** Use client-side WebCodecs export for v0.

From [[client-side-rendering]]: WebCodecs + mp4-muxer can render 1080x1920 MP4 in-browser at ~30 fps for canvas-rendered Remotion compositions. This covers the core export use case without any Lambda infrastructure.

Remotion Lambda would add:
- ~$0.003–0.01 per render (Lambda invocation + S3 storage)
- An IAM role with Lambda + S3 permissions
- A Lambda function deployed via `npx remotion lambda deploy`
- An S3 bucket for render output
- Terraform resources: `aws_lambda_function`, `aws_iam_role`, `aws_iam_role_policy`, `aws_s3_bucket`, `aws_s3_bucket_cors_configuration`

None of this is needed until the client-side path proves insufficient (e.g., very long compositions, background rendering, users without WebCodecs support). Add it in v0.5 as the ticket already scopes.

---

## 6. Minimal Terraform Configuration

This config provisions DynamoDB + S3 + SSM IAM policy + IAM user for the Fly.io backend. KMS CMK is omitted (use SSM SecureString instead).

```hcl
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = "us-east-1"
}

# ── DynamoDB Tables ──────────────────────────────────────────────────────────

resource "aws_dynamodb_table" "motion_users" {
  name         = "motion-users"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"

  attribute {
    name = "pk"
    type = "S"
  }

  tags = { app = "motion-design" }
}

resource "aws_dynamodb_table" "motion_sessions" {
  name         = "motion-sessions"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"

  attribute {
    name = "pk"
    type = "S"
  }

  # TTL for session expiry
  ttl {
    attribute_name = "expires_at"
    enabled        = true
  }

  tags = { app = "motion-design" }
}

resource "aws_dynamodb_table" "motion_design" {
  name         = "motion-design"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  # GSI for listing by entity type within an owner
  global_secondary_index {
    name            = "gsi1"
    hash_key        = "gsi1pk"
    range_key       = "gsi1sk"
    projection_type = "ALL"
  }

  attribute {
    name = "gsi1pk"
    type = "S"
  }

  attribute {
    name = "gsi1sk"
    type = "S"
  }

  tags = { app = "motion-design" }
}

# ── S3 Bucket (animation code blobs) ────────────────────────────────────────

resource "aws_s3_bucket" "motion_design_code" {
  bucket = "motion-design-code-${data.aws_caller_identity.current.account_id}"
  tags   = { app = "motion-design" }
}

resource "aws_s3_bucket_public_access_block" "motion_design_code" {
  bucket                  = aws_s3_bucket.motion_design_code.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "motion_design_code" {
  bucket = aws_s3_bucket.motion_design_code.id
  versioning_configuration {
    status = "Enabled"
  }
}

data "aws_caller_identity" "current" {}

# ── IAM User for Fly.io backend ──────────────────────────────────────────────

resource "aws_iam_user" "motion_backend" {
  name = "motion-design-backend"
  tags = { app = "motion-design" }
}

resource "aws_iam_access_key" "motion_backend" {
  user = aws_iam_user.motion_backend.name
}

resource "aws_iam_user_policy" "motion_backend" {
  name = "motion-design-backend-policy"
  user = aws_iam_user.motion_backend.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "DynamoDB"
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:Query",
          "dynamodb:TransactWriteItems",
        ]
        Resource = [
          aws_dynamodb_table.motion_users.arn,
          aws_dynamodb_table.motion_sessions.arn,
          aws_dynamodb_table.motion_design.arn,
          "${aws_dynamodb_table.motion_design.arn}/index/*",
        ]
      },
      {
        Sid    = "S3"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
        ]
        Resource = "${aws_s3_bucket.motion_design_code.arn}/*"
      },
      {
        Sid    = "SSMReadApiKeys"
        Effect = "Allow"
        Action = [
          "ssm:GetParameter",
          "ssm:GetParameters",
          "ssm:PutParameter",
        ]
        Resource = "arn:aws:ssm:us-east-1:${data.aws_caller_identity.current.account_id}:parameter/motion-design/*"
      }
    ]
  })
}

# ── Outputs ──────────────────────────────────────────────────────────────────

output "backend_access_key_id" {
  value     = aws_iam_access_key.motion_backend.id
  sensitive = false
}

output "backend_secret_access_key" {
  value     = aws_iam_access_key.motion_backend.secret
  sensitive = true
}

output "s3_bucket_name" {
  value = aws_s3_bucket.motion_design_code.bucket
}
```

Store the output `backend_secret_access_key` in Fly.io secrets:
```sh
fly secrets set AWS_ACCESS_KEY_ID=<key_id> AWS_SECRET_ACCESS_KEY=<secret>
```

---

## 7. Secrets Management

**Use SSM Parameter Store (free tier) for API keys. Use Fly.io secrets for environment variables.**

| Secret | Where to store | Why |
|---|---|---|
| Anthropic API key (per user) | SSM SecureString `/motion-design/users/{user_id}/anthropic_api_key` | KMS-encrypted at rest, no CMK cost, retrieved at runtime |
| Google OAuth client secret | Fly.io secrets (env var at runtime) | Never touches AWS; simplest path for a non-AWS-hosted backend |
| AWS access key for backend | Fly.io secrets | Backend needs it to call DynamoDB/S3/SSM |
| JWT signing secret | Fly.io secrets | Stays in memory; no need for SSM |

**AWS Secrets Manager**: $0.40/secret/month = $4.80/year for 10 secrets. Not worth it over SSM for this scale. SSM SecureString is free for standard parameters with <10K API calls/month.

**SSM parameter naming convention:**
```
/motion-design/users/{user_id}/anthropic_api_key   # SecureString
/motion-design/config/google_oauth_client_id        # String (not secret)
```

---

## 8. Summary Recommendations

| Decision | Recommendation | Rationale |
|---|---|---|
| IaC tool | Terraform | Simpler HCL, better DX than CDK for solo dev with minimal infra |
| DynamoDB billing | PAY_PER_REQUEST | No capacity planning; ~$0.15/month at 2 users |
| KMS CMK | Skip — use SSM SecureString | CMK costs $1/month flat; SSM SecureString is free and equally secure for this use case |
| Backend host | Fly.io (free tier) | Native Bun/SSE support, $0/month, no AWS ops overhead |
| Remotion Lambda | Defer to v0.5 | Client-side WebCodecs covers v0 export; Lambda adds cost and complexity not yet needed |
| Secrets | SSM for API keys, Fly.io secrets for env vars | Right tool for each type; no Secrets Manager cost |
| S3 versioning | Enable | Free at this scale; protects animation code blobs from accidental overwrites |
