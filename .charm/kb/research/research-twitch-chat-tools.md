---
id: research-twitch-chat-tools
root: research
type: domain
status: current
summary: "How to download Twitch VOD chat replay as JSON (TwitchDownloaderCLI is the recommended tool), what the JSON schema looks like, how to compute message-density virality signals, and platform/auth notes."
created: 2026-06-07
updated: 2026-06-07
---

# Twitch VOD Chat Download: Tools, Schema, and Virality Signals

## 1. Does yt-dlp support Twitch chat download?

**No -- not reliably.** yt-dlp's historical approach was `--write-subs --sub-langs rechat`, but the Twitch rechat API endpoint that backed it has been broken or rate-limited for years. As of early 2025 (GitHub issue #12437 on yt-dlp/yt-dlp, February 2025), there is no working yt-dlp path for VOD chat replay. The `--write-comments` flag is unrelated to Twitch chat. The `live_chat` sub-lang works for YouTube VODs, not Twitch.

**Recommendation:** Do not rely on yt-dlp for Twitch chat. Use TwitchDownloaderCLI instead.

## 2. TwitchDownloaderCLI -- the right tool

**Repo:** https://github.com/lay295/TwitchDownloader (lay295/TwitchDownloader)

### Installation

Pre-built binaries on the Releases page. No package manager install needed. On macOS Apple Silicon, download the `arm64` binary -- it runs natively, no Rosetta needed. An x64 binary will also run through Rosetta 2 if needed, but the arm64 build is preferred.

**Runtime dependency:** .NET 10.0.x (for building from source). The pre-built binary is self-contained and does not require .NET installed separately -- the release page offers both self-contained and framework-dependent builds.

### Chat download command

```bash
# Download chat from a VOD as JSON
TwitchDownloaderCLI chatdownload --id <VOD_ID> -o chat.json

# With embedded emote images (for offline render; makes file larger)
TwitchDownloaderCLI chatdownload --id <VOD_ID> --embed-images -o chat.json

# Trim to a time range (seconds)
TwitchDownloaderCLI chatdownload --id <VOD_ID> -b 120 -e 600 -o chat.json

# Gzip compression (40-90% smaller)
TwitchDownloaderCLI chatdownload --id <VOD_ID> -o chat.json --compression Gzip
```

Key flags:
- `--id` / `-u`: VOD ID or full VOD URL
- `-o`: Output file; extension determines format (`.json`, `.html`, `.txt`)
- `--embed-images` / `-E`: Embed first-party + third-party emote/badge images into the JSON (BTTV, FFZ, 7TV enabled by default when `-E` is set)
- `-b` / `-e`: Trim beginning / ending (in seconds, or `HH:MM:SS`)
- `--compression`: `None` (default) or `Gzip`
- `-t`: Parallel threads (default 4)

### JSON output structure

TwitchDownloaderCLI wraps the raw Twitch v5 API comment response. The top-level object contains a `comments` array:

```json
{
  "FileInfo": { ... },
  "streamer": { "name": "...", "id": 12345 },
  "video": {
    "title": "...",
    "id": "...",
    "start": 0.0,
    "end": 3600.0,
    "length": 3600.0,
    "viewCount": 50000,
    "game": "...",
    "chapters": [...]
  },
  "emotes": { "thirdParty": [...], "twitchBitsEmotes": [...] },
  "comments": [
    {
      "_id": "abc123",
      "created_at": "2024-03-15T20:15:43.830Z",
      "updated_at": "2024-03-15T20:15:43.830Z",
      "channel_id": "12345",
      "content_type": "video",
      "content_id": "9876543",
      "content_offset_seconds": 43.83,
      "commenter": {
        "_id": "67890",
        "display_name": "SomeUser",
        "name": "someuser",
        "type": "user",
        "bio": null,
        "created_at": "2020-01-01T00:00:00Z",
        "updated_at": "2024-01-01T00:00:00Z",
        "logo": "https://static-cdn.jtvnw.net/..."
      },
      "message": {
        "body": "PogChamp that was insane!",
        "bits_spent": 0,
        "fragments": [
          {
            "text": "PogChamp ",
            "emoticon": {
              "emoticon_id": "305954156",
              "emoticon_set_id": "0"
            }
          },
          {
            "text": "that was insane!",
            "emoticon": null
          }
        ],
        "is_action": false,
        "user_badges": [
          { "_id": "subscriber", "version": "6" }
        ],
        "user_color": "#2E8B57",
        "user_notice_params": { "msg-id": null },
        "emoticons": [
          {
            "id": "305954156",
            "begin": 0,
            "end": 8
          }
        ]
      }
    }
  ]
}
```

**Key fields per message:**
- `content_offset_seconds` (float) -- seconds from the start of the VOD; this is the primary timestamp for density analysis
- `commenter.display_name` -- viewer's username
- `message.body` -- raw chat text
- `message.user_color` -- hex color (may be null for users with no color set)
- `message.fragments` -- message broken into text runs and emote references; each fragment has `text` and an optional `emoticon` object
- `message.user_badges` -- list of badges (subscriber, mod, vip, bits, etc.)
- `message.bits_spent` -- cheer amount (0 for normal messages)
- `message.emoticons` -- Twitch first-party emotes used, with character offsets

## 3. Other tools

| Tool | Language/Runtime | Status | Output formats | Notes |
|---|---|---|---|---|
| **TwitchDownloaderCLI** | .NET / C# | Actively maintained (2025) | JSON, HTML, TXT | Best choice; ARM64 native macOS binary available |
| **RechatTool** (jdpurcell) | .NET / C# | v2.2.0 released Jan 2025 | JSON + TXT | Simpler but narrower; cross-platform via .NET 8 runtime |
| **tcd** (PetterKraabol) | Python | Last release May 2022 (stale) | IRC, SRT, SSA, JSON | Needs Twitch API credentials; unmaintained |
| **chat-downloader** (PyPI) | Python | Active | Multiple | Multi-platform (YouTube + Twitch); less VOD-specific |
| **yt-dlp** | Python | Broken for Twitch VOD chat | N/A | `--sub-langs rechat` was removed/broken; do not use |

**RechatTool** is a viable backup -- simpler CLI, less feature-rich than TwitchDownloaderCLI, but actively maintained as of Jan 2025. Its JSON preserves the same Twitch v5 comment structure.

## 4. Authentication / OAuth

For **public VODs**, no OAuth or API credentials are required by TwitchDownloaderCLI. It accesses the public Twitch API unauthenticated for chat download.

For **subscriber-only or private VODs**, an OAuth token from an account with access is required, and Twitch API restrictions mean chat download may be blocked entirely regardless of token. TwitchDownloaderCLI accepts an optional `--oauth` flag for the token.

## 5. macOS ARM (Apple Silicon) support

TwitchDownloaderCLI ships a native `arm64` binary. Download the `TwitchDownloaderCLI-osx-arm64` release artifact. No Rosetta 2 needed. The tool does NOT require .NET to be installed for the self-contained release -- the runtime is bundled.

Linux ARM64 is also supported via the `linux-arm64` binary.

## 6. Computing message-density virality signals

The `content_offset_seconds` field on each comment is the authoritative timestamp. Two approaches:

### Rolling window (sliding)
```python
import json
from collections import defaultdict

def messages_per_window(chat_path: str, window_s: float = 30.0) -> list[tuple[float, int]]:
    with open(chat_path) as f:
        data = json.load(f)
    comments = data["comments"]
    timestamps = [c["content_offset_seconds"] for c in comments]
    if not timestamps:
        return []
    
    results = []
    end_time = timestamps[-1]
    t = 0.0
    i = 0
    while t <= end_time:
        # count messages in [t, t + window_s)
        count = sum(1 for ts in timestamps if t <= ts < t + window_s)
        results.append((t, count))
        t += window_s  # step by window size for non-overlapping buckets
    return results
```

For a sliding (overlapping) window, keep a two-pointer and slide by a smaller step (e.g., 1s or 5s). Non-overlapping 30s buckets are simpler and sufficient for clip scoring.

### Fixed-bucket approach (faster for large chat logs)
```python
import json
import math

def bucket_density(chat_path: str, bucket_s: float = 30.0) -> dict[int, int]:
    with open(chat_path) as f:
        data = json.load(f)
    counts: dict[int, int] = defaultdict(int)
    for c in data["comments"]:
        bucket = int(c["content_offset_seconds"] // bucket_s)
        counts[bucket] += 1
    return counts  # key = bucket index, value = message count
```

To get messages-per-second from a bucket: `count / bucket_s`.

### Practical notes
- Exclude bot messages if known (check `commenter.name` against a bot list, e.g. `nightbot`, `streamelements`)
- Bits cheers (`message.bits_spent > 0`) and sub notices are high-signal moments worth separate tracking
- Emote-only messages (fragments all have `emoticon != null`) tend to cluster around hype moments -- tracking emote density separately can be a complementary signal
- Chat density alone is noisy; combine with audio energy and transcript excitement scores for a better virality signal (see `viral-clip-generation-pipeline.md`)

## Sources

- TwitchDownloaderCLI README: https://github.com/lay295/TwitchDownloader/blob/master/TwitchDownloaderCLI/README.md
- TwitchDownloader main README: https://github.com/lay295/TwitchDownloader
- yt-dlp Twitch chat issue #12437: https://github.com/yt-dlp/yt-dlp/issues/12437
- RechatTool: https://github.com/jdpurcell/RechatTool
- tcd on PyPI: https://pypi.org/project/tcd/
- chat-downloader on PyPI: https://pypi.org/project/chat-downloader/
- Twitch chat JSON field discussion: https://gist.github.com/Cqoicebordel/d9110b4b1191b9e9f6a8165438e00ea0
