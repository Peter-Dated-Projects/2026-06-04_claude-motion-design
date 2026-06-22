---
id: research-virality-signals
root: research
type: domain
status: current
summary: "How to score time windows of long-form gaming VODs for viral potential using audio RMS energy, transcript excitement, chat density, and frame delta — with recommended window sizes, weighting approaches, and tool comparisons."
created: 2026-06-07
updated: 2026-06-07
---

# Virality Scoring Signals for Long-Form Gaming Video

Research answers for pre-filtering candidate clip regions in Twitch VODs and game playthroughs before Claude does final selection.

---

## 1. Audio Energy: Computing RMS Per Window

**Core API:** `librosa.feature.rms(y, frame_length=2048, hop_length=512)` computes per-frame RMS. Default sample rate is 22050 Hz, so frame_length=2048 is ~93ms and hop_length=512 is ~23ms — much finer than needed for highlight detection.

**Practical pipeline for a VOD:**

```python
import librosa
import numpy as np

# Extract audio via ffmpeg first (faster than loading video directly):
# ffmpeg -i input.mp4 -ac 1 -ar 22050 audio.wav

y, sr = librosa.load("audio.wav", sr=22050, mono=True)

# Frame-level RMS (fine-grained)
rms_frames = librosa.feature.rms(y=y, frame_length=2048, hop_length=512)[0]

# Aggregate to 1-second windows for highlight scoring
frames_per_second = sr // 512  # ~43 frames/sec at hop_length=512
rms_1s = rms_frames[:len(rms_frames) // frames_per_second * frames_per_second]
rms_1s = rms_1s.reshape(-1, frames_per_second).mean(axis=1)

# Normalize to [0,1] using adaptive window or global percentile
rms_norm = (rms_1s - np.percentile(rms_1s, 5)) / (np.percentile(rms_1s, 95) - np.percentile(rms_1s, 5))
rms_norm = np.clip(rms_norm, 0, 1)
```

**Alternative with pydub** (simpler, no STFT overhead):

```python
from pydub import AudioSegment
import numpy as np

audio = AudioSegment.from_file("input.mp4")
chunk_ms = 1000  # 1 second windows
rms_values = [audio[i:i+chunk_ms].rms for i in range(0, len(audio), 500)]  # 0.5s stride
```

**Recommended window/stride for highlight detection:**
- 1-second windows, 0.5-second stride for the audio RMS pass
- 5-second pooled windows (max-pool 1s scores) for coarser candidate filtering
- This gives ~14,400 score values for a 2-hour VOD — trivially fast

**Sources:** [librosa.feature.rms docs](https://librosa.org/doc/main/generated/librosa.feature.rms.html), [librosa tutorial](https://librosa.org/doc/0.11.0/tutorial.html)

---

## 2. Transcript Excitement Signals

### Keyword patterns (strongest for gaming)

The PogChampNet project (Visor.gg, 2018) validated that Twitch chat keywords reliably co-occur with highlight moments. The same keywords work in streamer transcripts:

| Category | Examples |
|---|---|
| Twitch-native | PogChamp, Poggers, POG, LULW, KEKW, OMEGALUL, Pog |
| Universal exclamations | wow, holy shit, LET'S GO, LETS GO, NO WAY, ARE YOU KIDDING |
| Death/clutch signals | eliminated, clutch, ace, snipe, one shot |
| Profanity spike | any run of profanity in a short window is a strong signal |

**Feature: excitement density** — count keyword hits per N-second window, normalize by window length.

### Short-text excitement classifiers

- **cardiffnlp/twitter-roberta-base-sentiment** (HuggingFace) — fine-tuned on social media text, handles exclamatory fragments well. The "positive" class maps loosely to excitement.
- **distilbert-base-uncased-finetuned-sst-2-english** — lighter, English only, reasonable proxy for emotional intensity in transcript segments.
- For raw speed: a simple keyword density score outperforms classifiers for gaming transcripts because the vocabulary is small and domain-specific.

### Practical approach

Use keyword density as the primary signal; run a small classifier (distilbert or similar) only on windows that pass the keyword threshold. This avoids running inference on hours of neutral content.

**Sources:** [PogChampNet article](https://medium.com/@farzatv/pogchampnet-how-we-used-twitch-chat-deep-learning-to-create-automatic-game-highlights-with-only-61ed7f7b22d4), [Deepgram sentiment docs](https://developers.deepgram.com/docs/sentiment-analysis)

---

## 3. What Commercial AI Clipping Tools Use

### StreamLadder ClipGPT

Uses a proprietary virality score (0-100) based on four signals explicitly documented on their site:

1. **Audio energy** — loudness/intensity of the moment
2. **Visual action** — motion, scene cuts, visual complexity delta
3. **Reaction intensity** — streamer vocal reaction + chat spike co-occurrence
4. **Contextual independence** — whether the clip makes sense without surrounding context (detected via transcript coherence)

ClipGPT additionally cross-references chat activity: it flags moments where "chat spikes and voice gets louder at the same time" as the highest-confidence highlights.

### Choppity

Uses transcript-first scoring: transcribes at 95%+ accuracy, then scores each segment against "clip objectives" tuned per use case — viral hooks, emotional peaks, complete story arcs, quotable insights. The model is looking for complete thoughts that stand alone, not just loud moments.

### Eklipse

Game-specific trained models (CoD, Fortnite, Valorant, etc.) for visual event detection (kill, squad wipe, clutch play) combined with chat spike detection. Connects directly to Twitch/YouTube API to pull the VOD and chat replay together.

### Replicable signals

- Audio energy + chat density co-spike: entirely replicable locally
- Visual frame delta (consecutive frame difference via OpenCV): replicable
- Transcript coherence scoring: requires an LLM or embedding similarity model
- Game-specific event detection: requires labeled training data per game

**Sources:** [StreamLadder virality score](https://streamladder.com/clipgpt-features/ai-virality-score), [ClipGPT overview](https://streamladder.com/tools/clipgpt), [Choppity](https://www.choppity.com/tools/free-ai-clip-maker/), [Eklipse](https://eklipse.gg/features/ai-highlights/)

---

## 4. Composite Score: Normalization and Weighting

### General approach

Normalize each signal independently to [0,1] using adaptive percentile normalization (5th–95th percentile clipping is more robust than min-max for VODs with outlier moments):

```python
def percentile_normalize(arr, lo=5, hi=95):
    lo_val, hi_val = np.percentile(arr, lo), np.percentile(arr, hi)
    return np.clip((arr - lo_val) / (hi_val - lo_val + 1e-9), 0, 1)
```

Then compute a weighted sum:

```python
composite = (
    0.35 * rms_norm         # audio energy — strongest single signal
  + 0.30 * chat_norm        # chat density spike — high precision for gaming
  + 0.20 * transcript_norm  # keyword/excitement density
  + 0.15 * frame_delta_norm # visual action (optional; expensive to compute)
)
```

### Evidence for weights

The automated sport highlight detection paper (arxiv 2501.16100) reports audio models reach 89% accuracy vs. 83% for video, supporting audio as the dominant signal. Chat density is gaming-specific but extremely high-precision (PogChampNet validated this). Transcript excitement is a useful tie-breaker but noisier.

### Smoothing

Apply a Gaussian or triangular smoothing kernel across the composite score time series before thresholding — this merges adjacent high-scoring frames into clip-length regions rather than point detections:

```python
from scipy.ndimage import gaussian_filter1d
composite_smooth = gaussian_filter1d(composite, sigma=3)  # sigma in seconds if stride=1s
```

**Sources:** [MINI-Net arxiv](https://arxiv.org/abs/2007.09833), [Sport highlight detection arxiv](https://arxiv.org/abs/2501.16100)

---

## 5. Open-Source Models and Libraries

No well-maintained general-purpose open-source gaming highlight library exists as of mid-2026. Options:

| Tool | Status | Notes |
|---|---|---|
| **PogChampNet** (Visor.gg) | Unmaintained (2018) | InceptionResNetV2 on video frames, labels from chat spikes; approach is valid but no pip package |
| **Streamlabs Highlighter** | Proprietary | Game-specific models, not open |
| **Eklipse / Powder** | Proprietary SaaS | API access only |
| **librosa + whisper + custom scoring** | Open, actively maintained | The practical DIY path — combine audio RMS (librosa), transcription (whisper), chat download (see T-003 research) |

**Recommended DIY stack:**
- `librosa` for audio feature extraction
- `openai-whisper` (or `faster-whisper`) for transcription
- `opencv-python` for frame delta (optional)
- Twitch chat replay (see T-003) for chat density signal
- Custom weighted scoring as described above

This replicates what commercial tools do without game-specific training data requirements.

---

## 6. Recommended Window Size and Stride for 2-Hour VOD

| Pass | Window | Stride | Purpose |
|---|---|---|---|
| Audio RMS (fast) | 1 s | 0.5 s | Initial scoring pass, runs in <30s for 2h VOD |
| Chat density | 30 s | 5 s | Count messages per window; smoothed |
| Transcript excitement | 10 s | 2 s | Only on audio-hot regions to save inference time |
| Frame delta | 2 s | 1 s | Optional; expensive — run on top candidates only |
| Candidate merge | 30 s | — | Merge adjacent high-scoring windows into clip regions |

**Efficiency strategy for a 2-hour VOD:**

1. Run audio RMS pass over the full VOD (cheapest, ~seconds).
2. Run chat density over the full VOD (just counting lines in a JSON — trivial).
3. Compute composite score for audio + chat only.
4. Retain windows above the 85th percentile as "candidate regions."
5. Run transcript excitement and frame delta only on candidate regions (~10-20% of total duration).
6. Re-score candidates with all four signals, rank, output top N clip regions.

This approach keeps expensive operations (transcription, frame extraction) to a fraction of the full VOD.

**For the initial scanning pass, a 5-second window with 1-second stride is a sensible default** — it's coarse enough to be fast, fine enough to not miss a 10-second moment that peaks in the middle.

---

## Summary Table

| Signal | Library/Tool | Window | Weight | Notes |
|---|---|---|---|---|
| Audio RMS energy | librosa / pydub | 1s / 0.5s stride | 0.35 | Strongest single signal |
| Chat density | custom (Twitch API) | 30s / 5s stride | 0.30 | High precision for gaming |
| Transcript excitement | whisper + keywords | 10s / 2s stride | 0.20 | Run on hot regions only |
| Frame delta | opencv | 2s / 1s stride | 0.15 | Optional; use for tie-breaking |
