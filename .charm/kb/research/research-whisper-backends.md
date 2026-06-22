---
id: research-whisper-backends
root: research
type: architecture
status: current
summary: "On Apple Silicon, mlx-whisper (Metal via MLX) is the fastest Python-native ASR backend at ~2x over whisper.cpp; faster-whisper has no Metal support; large-v3-turbo is the recommended model; word-level timestamps are native in faster-whisper and mlx-whisper, with WhisperX forced alignment giving ±50ms accuracy."
created: 2026-06-07
updated: 2026-06-07
---

# Whisper Backends on Apple Silicon — Word-Level Transcription Research

Research target: selecting the best local Whisper ASR backend for 1-2 hour audio on Apple Silicon (M-series) with word-level timestamps, for use in a long-form video viral clip pipeline.

---

## 1. Speed comparison on Apple Silicon

| Backend | Metal/GPU | Realtime factor (large-v3-turbo, M2 Pro) | Notes |
|---|---|---|---|
| mlx-whisper | Yes (MLX/Metal) | ~10–18x | Fastest Python-native option; ~2x over whisper.cpp on same model |
| whisper.cpp | Yes (Metal) | ~10–14x | C/C++ port; Python via pywhispercpp (third-party bindings) |
| faster-whisper | NO (CPU INT8 only) | ~3–6x (CPU) | CTranslate2 has no MPS/Metal backend on macOS as of 2025-2026 |
| WhisperX | Inherits faster-whisper (CPU) | ~3–6x on Mac | Uses faster-whisper as backbone; add forced alignment overhead |

**mlx-whisper is the clear winner on Apple Silicon for raw transcription speed.** It uses Apple's MLX framework with Metal GPU, achieving roughly 2x over whisper.cpp on the same model. On an M2 Ultra, large-v3-turbo transcribes 12 minutes of audio in ~14 seconds (~50x realtime).

For a 1-2 hour recording, mlx-whisper with large-v3-turbo is the right first-pass transcription engine.

---

## 2. Word-level timestamp support

### faster-whisper

Native. Pass `word_timestamps=True`. Each segment has a `.words` list of `Word` dataclass instances.

```python
from faster_whisper import WhisperModel

model = WhisperModel("large-v3-turbo", device="cpu", compute_type="int8")
segments, info = model.transcribe("audio.mp3", word_timestamps=True)

for segment in segments:
    for word in segment.words:
        # word.start: float (seconds)
        # word.end:   float (seconds)
        # word.word:  str
        # word.probability: float (0.0–1.0)
        print(word.start, word.end, word.word, word.probability)
```

`Word` dataclass fields: `start: float`, `end: float`, `word: str`, `probability: float`.

### mlx-whisper

Native. Pass `word_timestamps=True`. Output is a dict with `segments[i]["words"]` as a list of dicts.

```python
import mlx_whisper

result = mlx_whisper.transcribe(
    "audio.mp3",
    path_or_hf_repo="mlx-community/whisper-large-v3-turbo",
    word_timestamps=True,
)

for seg in result["segments"]:
    for w in seg["words"]:
        # w["start"]:       float
        # w["end"]:         float
        # w["word"]:        str
        # w["probability"]: float
        print(w["start"], w["end"], w["word"], w["probability"])
```

Word dict keys: `start`, `end`, `word`, `probability`. Matches faster-whisper's field names.

### whisper.cpp

Produces token-level timestamps natively. Word-level output requires `--max-len 1` (split on every token) or using `--split_on_word` via `pywhispercpp`. The Python binding ecosystem (pywhispercpp, whisper-cpp-python) is third-party and less stable than faster-whisper/mlx-whisper for production use.

### WhisperX (forced alignment)

WhisperX does NOT produce independent timestamps — it runs faster-whisper for transcription then applies wav2vec2 forced alignment to snap each word to its precise audio position. Accuracy is ±50ms (vs ±500ms from vanilla Whisper).

Word output after alignment has fields: `word` (str), `start` (float), `end` (float), `score` (float, confidence from aligner).

```python
import whisperx

model = whisperx.load_model("large-v3-turbo", device="cpu", compute_type="int8")
audio = whisperx.load_audio("audio.mp3")
result = model.transcribe(audio, batch_size=16)

model_a, metadata = whisperx.load_align_model(
    language_code=result["language"], device="cpu"
)
result = whisperx.align(
    result["segments"], model_a, metadata, audio, "cpu",
    return_char_alignments=False,
)

for seg in result["segments"]:
    for w in seg["words"]:
        # w["word"]:  str
        # w["start"]: float
        # w["end"]:   float
        # w["score"]: float  (alignment confidence, not ASR probability)
        print(w["start"], w["end"], w["word"], w["score"])
```

Note: words with non-dictionary characters (e.g., "2014." or currency symbols) cannot be aligned and are skipped — they appear in segments but without `start`/`end` keys.

---

## 3. faster-whisper Metal backend

**No.** CTranslate2, the inference engine under faster-whisper, does not support Apple's Metal Performance Shaders as of 2025-2026. It falls back to CPU with INT8 quantization. On M-series CPUs this is still fast, but it is materially slower than mlx-whisper Metal or whisper.cpp Metal for equivalent models.

**CPU INT8 speed on M-series vs mlx-whisper Metal:** mlx-whisper Metal is roughly 2-4x faster for large-v3-turbo on M2/M3.

---

## 4. Model recommendations

| Model | Params | Decoder layers | Realtime factor (M2 Pro) | WER vs large-v3 |
|---|---|---|---|---|
| large-v3 | 1.54B | 32 | ~2–3x (Metal) | baseline |
| large-v3-turbo | 809M | 4 | ~10–18x (Metal) | +0.4% |
| distil-large-v3 | ~756M | 2 | ~14–20x | ~+1.4% |

**large-v3-turbo is the recommended model.** It is ~4-5x faster than large-v3 with <0.5% WER degradation on English. It was fine-tuned (not distilled) from large-v3 with 4 decoder layers; it preserves full multilingual capability and the 32-layer encoder. On YouTube-commons: 13.40% WER (turbo) vs 13.20% (large-v3).

**distil-large-v3** is faster still but drops accuracy further (~1% higher WER than turbo) and has weaker multilingual support. Only prefer it if max throughput matters more than quality.

**large-v3** only makes sense when accuracy is the critical constraint — it runs at ~2-3x realtime on Metal (vs 10-18x for turbo), meaning a 1-hour file takes ~20 minutes vs ~4 minutes.

For a viral clip pipeline processing long recordings, **large-v3-turbo is the right call**.

---

## 5. WhisperX on Apple Silicon

Yes, WhisperX runs on Apple Silicon. It must use CPU mode since CTranslate2 has no Metal backend:

```bash
whisperx audio.wav --compute_type int8 --device cpu
```

Or in Python:
```python
model = whisperx.load_model("large-v3-turbo", device="cpu", compute_type="int8")
```

WhisperX is the right choice when you need forced-alignment word timestamps (±50ms) rather than Whisper's native word timestamps (±200-500ms). For karaoke-style subtitle burn-in, forced alignment is meaningfully more precise.

The alignment models (wav2vec2) are provided for en, fr, de, es, it via torchaudio, and additional languages via Hugging Face pipelines.

---

## 6. Recommended approach for viral clip pipeline

For a 1-2 hour audio file on Apple Silicon with word-level output:

**Option A — mlx-whisper only (simpler, fast, good precision)**
- Use mlx-whisper with large-v3-turbo and `word_timestamps=True`
- Word timestamps are ±200ms accurate (Whisper's dynamic-programming alignment)
- Sufficient for most clip-detection use cases; word dict fields: `start, end, word, probability`

**Option B — mlx-whisper + WhisperX align (recommended for subtitle use)**
- Transcribe with mlx-whisper for speed (Metal GPU, 10-18x realtime)
- Run WhisperX forced alignment pass on the transcript to refine timestamps to ±50ms
- mlx-whisper alone does the heavy lifting; WhisperX adds a fast alignment-only pass
- Word dict fields after align: `start, end, word, score`

**Option C — WhisperX end-to-end (simpler pipeline, slower transcription)**
- WhisperX handles transcription (via faster-whisper, CPU INT8) + alignment in one call
- Slower transcription on Mac than mlx-whisper (no Metal), but single-library simplicity
- Acceptable if speed is not critical and you want one dependency

For the viral clip pipeline, Option B gives the best speed-accuracy tradeoff. Option A is the pragmatic starting point.

---

## Sources

- [whisper.cpp GitHub (ggml-org)](https://github.com/ggml-org/whisper.cpp)
- [mlx-whisper PyPI](https://pypi.org/project/mlx-whisper/)
- [faster-whisper GitHub (SYSTRAN)](https://github.com/SYSTRAN/faster-whisper)
- [WhisperX GitHub (m-bain)](https://github.com/m-bain/whisperX)
- [mlx_whisper vs whisper.cpp benchmark (billmill.org, 2026)](https://notes.billmill.org/dev_blog/2026/01/updated_my_mlx_whisper_vs._whisper.cpp_benchmark.html)
- [Whisper Large V3 Turbo benchmark on Mac (WhisperNotes)](https://whispernotes.app/blog/introducing-whisper-large-v3-turbo)
- [Whisper Performance on Apple Silicon benchmarks (voicci.com)](https://www.voicci.com/blog/apple-silicon-whisper-performance.html)
- [faster-whisper vs whisper.cpp CoreML discussion](https://github.com/SYSTRAN/faster-whisper/discussions/368)
- [Choosing Whisper variants (modal.com)](https://modal.com/blog/choosing-whisper-variants)
- [Whisper Large V3 Turbo demystified (amgadhasan.substack.com)](https://amgadhasan.substack.com/p/demystifying-openais-new-whisper)
