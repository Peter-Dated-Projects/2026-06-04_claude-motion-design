---
id: instagram-public-reel-no-cookies
root: gotchas
type: gotcha
status: current
summary: "A public Instagram reel downloads via yt-dlp (2026.03.17) with NO cookies/auth on the first attempt — yt-dlp sets up a guest session and pulls public reel metadata. Cookies (`--cookies-from-browser`) are a fallback for private/age-gated/rate-limited content only, NOT a required first-run step."
created: 2026-06-06
updated: 2026-06-06
---

The Instagram-pipeline proposal's biggest assumed risk — "Instagram requires a
one-time browser-cookie export" — did not hold. Spike (2026-06-06), public reel:

```bash
yt-dlp --format mp4 -o source.mp4 \
  'https://www.instagram.com/reel/DYsvvtAhLUQ/'   # exit 0, 1.01 MiB, no auth
```

Implication for the build: implement download as no-cookie-first, and only fall
back to `--cookies-from-browser firefox` (or chrome) when the error is
specifically login-required / age-gated / rate-limited. Do NOT build cookie
export as a mandatory onboarding step — the common case (public reel URL) is
zero-config, which materially improves the demo/onboarding story.

Caveat: one public reel is not a guarantee. Private accounts, age-gated content,
and IP rate-limiting will still need the cookie fallback.
