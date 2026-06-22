---
id: research-subtitle-formats
root: research
type: domain
status: current
summary: "Word-level karaoke subtitle generation from Whisper timestamps: ASS tag syntax, Python library evaluation (stable-ts recommended), ffmpeg burn-in commands, and short-form social media style defaults."
created: 2026-06-07
updated: 2026-06-07
---

# Word-Level Subtitle Formats and ASS Karaoke Burn-in

Research covering ASS karaoke tag syntax, Python libraries for subtitle generation from Whisper word timestamps, ffmpeg burn-in, and social media caption style defaults.

---

## 1. ASS Karaoke Tag Syntax

All karaoke tags take a duration in **centiseconds** (1 cs = 10 ms = 0.01 s). Tags are placed inline before each word or syllable in the dialogue text.

| Tag | Effect |
|---|---|
| `\k<cs>` | Instant switch: word displayed in secondary color before its time, flips to primary color the instant the syllable starts. |
| `\kf<cs>` or `\K<cs>` | Sweep fill: word starts in secondary color, fills left-to-right to primary over the syllable's duration. The sweep completes exactly when the duration expires. Best for karaoke word-by-word highlighting. |
| `\ko<cs>` | Outline reveal: word outline is hidden before the syllable, appears instantly when it starts. |
| `\kt<ms>` | Offset the next syllable's start relative to the event start (in **milliseconds**, not cs). Poorly supported — avoid unless targeting Aegisub only. |

Typical usage for word highlight: use `\kf` (sweep) or `\k` (instant). `\kf` looks more natural for speech sync.

Converting Whisper word timestamps to centiseconds:
```python
cs = round(word_duration_seconds * 100)
```

### Example inline text
```
{\kf30}Hello {\kf25}world, {\kf40}this {\kf20}is {\kf50}karaoke.
```

The full event line starts at the sentence start time; the `\kf` values encode each word's duration relative to that start. The sum of all `\kf` durations should equal the event's total duration in centiseconds.

---

## 2. Python Libraries for ASS Generation from Whisper

### Recommendation: stable-ts

**stable-ts** is the best choice for direct karaoke ASS generation from Whisper word timestamps. It wraps Whisper, stabilizes the word-level timestamps (Whisper's raw word timestamps can drift), and outputs ASS with karaoke tags in a single call.

```python
import stable_whisper

model = stable_whisper.load_model('base')
result = model.transcribe('audio.mp3')

# Karaoke ASS with sweep highlighting
result.to_ass(
    'output.ass',
    word_level=True,
    karaoke=True,
    highlight_color='00ff00'  # hex, BGR order
)
```

The `highlight_color` maps to the ASS `SecondaryColour` (the pre-highlight color). The `PrimaryColour` (post-highlight) comes from the style definition.

### pysubs2 — use for manual / programmatic construction

**pysubs2** (v1.8+) is the best library for reading, writing, and constructing ASS files programmatically when you already have word timestamps and want full control over styling. It does not generate karaoke tags itself, but you build them in the `text` field of each `SSAEvent`.

```python
import pysubs2
from pysubs2 import SSAFile, SSAEvent, SSAStyle, make_time

subs = SSAFile()

# Define style
style = SSAStyle(
    fontname="Montserrat",
    fontsize=80,
    primarycolor=pysubs2.Color(255, 255, 255, 0),   # white
    secondarycolor=pysubs2.Color(255, 255, 0, 0),   # yellow highlight
    outlinecolor=pysubs2.Color(0, 0, 0, 0),
    bold=True,
    outline=4,
    shadow=2,
    alignment=2,    # bottom-center
    marginv=300,
)
subs.styles["Default"] = style

# Build one event per sentence, words encoded with \kf
words = [("Hello", 0.0, 0.35), ("world", 0.35, 0.72), ("here", 0.72, 1.10)]
sentence_start_ms = 0
sentence_end_ms = 1100

karaoke_text = ""
for word, wstart, wend in words:
    duration_cs = round((wend - wstart) * 100)
    karaoke_text += f"{{\\kf{duration_cs}}}{word} "

event = SSAEvent(
    start=make_time(ms=sentence_start_ms),
    end=make_time(ms=sentence_end_ms),
    text=karaoke_text.strip()
)
subs.events.append(event)

subs.save("output.ass")
```

pysubs2 `Color` takes `(r, g, b, a)` in 0-255 each; it converts to ASS's BGR hex internally.

### auto-subs — use for high-level karaoke pipeline

**auto-subs** provides an end-to-end pipeline including Whisper transcription, word segmentation, and ASS generation with advanced styling. Best if you want a higher-level abstraction with built-in Pydantic-validated style configs.

```python
from auto_subs import AssSettings, AssStyleSettings

settings = AssSettings(highlight_style=AssStyleSettings())
# generates karaoke ASS using {\k...} tags
```

Useful when you want the whole pipeline (transcribe → segment → style → ASS) without building the individual layers.

### whisper-timestamped — avoid for primary use

**whisper-timestamped** produces word-level timestamps but adds complexity and its own accuracy concerns — Whisper was not trained to predict per-word timestamps, so all post-hoc methods (including stable-ts) are approximations. stable-ts's stabilization approach is more mature. whisper-timestamped is an alternative if you already have it in your stack, not a first choice.

### Summary table

| Library | Best for | Karaoke ASS output | Whisper integration |
|---|---|---|---|
| stable-ts | Direct karaoke generation | Yes, `to_ass(karaoke=True)` | Built-in |
| pysubs2 | Programmatic ASS construction | Manual (build tags in text) | None (you supply timestamps) |
| auto-subs | High-level pipeline | Yes, via AssSettings | Built-in |
| whisper-timestamped | Not recommended | No direct | Built-in |

---

## 3. Minimal Working ASS File for a 30s Clip

For a 1080x1920 (portrait/9:16) clip. Colors use ASS's `&HAABBGGRR` format (alpha, blue, green, red).

```
[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
Collisions: Normal
Timer: 100.0000

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Montserrat,80,&H00FFFFFF,&H0000FFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,4,2,2,20,20,300,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:02.50,Default,,0,0,0,,{\kf40}This {\kf35}is {\kf50}the {\kf60}first {\kf70}sentence.
Dialogue: 0,0:00:02.50,0:00:05.20,Default,,0,0,0,,{\kf55}And {\kf45}this {\kf40}is {\kf65}the {\kf80}second.
```

Color breakdown for the Default style:
- `PrimaryColour &H00FFFFFF` — white text (fully opaque)
- `SecondaryColour &H0000FFFF` — yellow pre-highlight (BGR: 00=blue, FF=green, FF=red → yellow)
- `OutlineColour &H00000000` — black outline
- `BackColour &H00000000` — black shadow

ASS colors are `&HAABBGGRR`:
- HTML `#FFFF00` (yellow) → BGR `00FFFF` → ASS `&H0000FFFF`
- HTML `#FFFFFF` (white) → BGR `FFFFFF` → ASS `&H00FFFFFF`
- HTML `#000000` (black) → BGR `000000` → ASS `&H00000000`

`Alignment: 2` = bottom-center (numpad layout: 1=BL, 2=BC, 3=BR, 7=TL, 8=TC, 9=TR).
`MarginV: 300` = 300px from the bottom edge (at PlayResY=1920).

---

## 4. ffmpeg Burn-in Commands

### Burn ASS directly
```bash
ffmpeg -i input.mp4 -vf "ass=subtitle.ass" -c:a copy output.mp4
```
The `ass` filter reads the ASS file including all karaoke tags and renders them via libass.

### Burn with custom font directory
```bash
ffmpeg -i input.mp4 -vf "ass=subtitle.ass:fontsdir=/path/to/fonts" -c:a copy output.mp4
```

### Burn SRT with style overrides (no karaoke)
```bash
ffmpeg -i input.mp4 \
  -vf "subtitles=subtitle.srt:force_style='Fontname=Montserrat,Fontsize=24,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=4,Bold=1,Alignment=2,MarginV=300'" \
  -c:a copy output.mp4
```
`force_style` only works with the `subtitles` filter, not `ass`. It overrides style fields in the same syntax as the ASS `[V4+ Styles]` Format line.

### Positional control

**Method 1: MarginV in the style definition** (preferred for all lines)
Set `MarginV` in the `[V4+ Styles]` section; controls distance from the relevant screen edge for the chosen alignment.

**Method 2: `\pos(x,y)` inline tag** (per-line override)
```
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\pos(540,1600)\kf40}Word {\kf50}here
```
`x=540` centers at 1080/2; `y=1600` places it 1600px from the top (320px from bottom at 1920px height). `\pos` overrides MarginV for that line.

**Method 3: `\an` alignment override** (per-line)
```
{\an8\kf40}Top {\kf35}caption
```
`\an8` = top-center. Combine with `\pos` for absolute placement.

---

## 5. SRT and Per-Word Highlighting

**SRT cannot do karaoke.** SRT only supports basic inline markup: `<b>`, `<i>`, `<u>`, `<font color="...">`. There is no timing sub-tag for words within a line. The entire SRT line appears and disappears as a unit.

For any per-word highlighting or progressive fill, ASS is required. The `\kf` (or `\k`) tag in ASS is the only standard mechanism.

If you need a pipeline that starts from SRT (e.g., received from an external transcription service), the approach is:
1. Parse SRT segments.
2. Run word alignment (stable-ts, forced alignment, or auto-subs "upgrade") to get word timestamps within each segment.
3. Build an ASS file using pysubs2 with `\kf` tags from those word timestamps.

---

## 6. Short-Form Social Media Caption Style Defaults

These are battle-tested defaults for 1080x1920 portrait video (TikTok, Reels, Shorts).

### Font
- **Montserrat Bold** — most common among top creators; geometric sans-serif, reads fast on mobile
- **Poppins Bold** — close second, rounder and softer
- Avoid serif or script fonts — they fail at small sizes on mobile

### ASS style block (ready to paste)

```
Style: Default,Montserrat,80,&H00FFFFFF,&H0000FFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,4,2,2,20,20,300,1
```

Breakdown:
- `Fontsize 80` at PlayResY=1920 ≈ 4% of screen height; comfortable on mobile
- `PrimaryColour &H00FFFFFF` — white text
- `SecondaryColour &H0000FFFF` — yellow highlight (most common; alternatives: red `&H000000FF`, green `&H0000FF00`)
- `OutlineColour &H00000000` — black outline, 4px
- `Shadow 2` — 2px drop shadow for depth
- `Bold -1` (true)
- `Alignment 2` — bottom-center
- `MarginV 300` — 300px from bottom, clears TikTok/Reels UI chrome (like/share buttons sit in the bottom ~200px zone)

### Line grouping
- Display 2-4 words per line (not full sentences); keeps reading fast
- Each event should represent one breath or natural phrase boundary

### Highlight color conventions
- Yellow (`#FFFF00` / `&H0000FFFF`) is the de facto standard
- Red (`#FF0000` / `&H000000FF`) for high-energy emphasis
- Green (`#00FF00` / `&H0000FF00`) for affirmative/positive moments

### Placement
- **Bottom third** with MarginV 200-350: keeps text above the platform UI overlay
- **Top placement** (`\an8`, MarginV 100-150): use when speaker's face is at bottom of frame
- Avoid the very bottom 200px — TikTok/Reels like/comment buttons overlay there

---

## Sources

- Aegisub ASS Tags documentation: https://aegisub.org/docs/latest/ass_tags/
- pysubs2 API reference: https://pysubs2.readthedocs.io/en/latest/api-reference.html
- stable-ts GitHub (jianfch/stable-ts): https://github.com/jianfch/stable-ts
- auto-subs PyPI: https://pypi.org/project/auto-subs/
- Bannerbear ffmpeg subtitle guide: https://www.bannerbear.com/blog/how-to-add-subtitles-to-a-video-file-using-ffmpeg/
- Blitzcutai TikTok caption fonts: https://blitzcutai.com/blog/best-caption-fonts-tiktok
- Vexub short-form subtitle styles: https://vexub.com/blog/best-subtitle-styles-social-media
