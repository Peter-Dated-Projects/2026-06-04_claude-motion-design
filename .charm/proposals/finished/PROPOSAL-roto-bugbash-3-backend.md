# Rotoscoping Bug Bash 3 — Backend GPU Configuration and Auto Theme

Two independent improvements: auto-detection of the installed CUDA GPU generation
so the service configures itself optimally on 40-series, 50-series, and similar
hardware; and an "Auto" option in the app's theme settings that follows the OS
system preference instead of requiring manual toggle.

---

## 1. Auto-detect GPU generation and configure accordingly

**Problem.** The service uses a fixed `torch.autocast("cuda", dtype=torch.bfloat16)`
in `sam2_engine.py` (added in bug bash 1). This works on 30-series and newer
Ampere/Ada/Blackwell cards that support bfloat16, but it has never been tested on
50-series (Blackwell) hardware and currently has no startup validation step. There
is also no mechanism to downgrade gracefully when the GPU does not support a given
dtype, or to enable architecture-specific optimizations (TF32 on Ampere, SDPA
attention on Ada/Blackwell). Mac runs should be blocked at startup since the
service requires CUDA.

**Proposed approach.** At startup (`load_predictor` in `sam2_engine.py`), run a
one-time GPU probe and store the result in a module-level `_GPU_PROFILE` dict.
The `run_job` function consults this profile when configuring `torch.autocast` and
any per-job flags.

**GPU probe logic.**

```python
def _probe_gpu() -> dict:
    """
    Probe the CUDA GPU and return a configuration profile.
    Raises RuntimeError if no CUDA device is available.
    """
    if not torch.cuda.is_available():
        raise RuntimeError(
            "No CUDA device found. This service requires a CUDA-capable GPU. "
            "Mac and CPU-only runs are not supported."
        )
    props = torch.cuda.get_device_properties(0)
    major, minor = props.major, props.minor
    name = props.name
    vram_gb = props.total_memory / (1024 ** 3)

    # Compute capability -> generation mapping (NVIDIA convention):
    #   sm_60-61: Pascal (10-series)
    #   sm_70-72: Volta (Titan V, V100)
    #   sm_75: Turing (16-series, 20-series)
    #   sm_80-86: Ampere (30-series, A-series)
    #   sm_89: Ada (40-series)
    #   sm_90: Hopper (H100, H200)
    #   sm_100+: Blackwell (50-series, GB200)
    if major >= 10:
        generation = "blackwell"     # RTX 5000-series / GB200
    elif major == 9:
        generation = "hopper"        # H100, H200 -- bfloat16 + FlashAttn
    elif major == 8 and minor == 9:
        generation = "ada"           # RTX 4000-series
    elif major == 8:
        generation = "ampere"        # RTX 3000-series
    elif major == 7 and minor == 5:
        generation = "turing"
    else:
        generation = "legacy"

    # Dtype selection: bfloat16 is preferred on Ampere+ (hardware-accelerated);
    # Turing supports fp16 but not bfloat16 in hardware; legacy falls back to fp32.
    if generation in ("blackwell", "hopper", "ada", "ampere"):
        dtype = torch.bfloat16
    elif generation == "turing":
        dtype = torch.float16
    else:
        dtype = torch.float32

    # TF32: enabled by default on Ampere+, but explicitly set here so the log
    # is authoritative. Turing and below do not support TF32.
    use_tf32 = generation in ("blackwell", "hopper", "ada", "ampere")
    torch.backends.cuda.matmul.allow_tf32 = use_tf32
    torch.backends.cudnn.allow_tf32 = use_tf32

    # dtype_str is a JSON-safe label used in /health and logging; torch.dtype
    # objects are not JSON-serializable so never put `dtype` directly in a
    # response dict that gets json.dumps'd.
    dtype_str = str(dtype).replace("torch.", "")  # e.g. "bfloat16"

    logger.info(
        "GPU probe: %s (sm_%d%d, %s, %.1f GB VRAM) | dtype=%s tf32=%s",
        name, major, minor, generation, vram_gb,
        dtype_str, use_tf32,
    )
    return {
        "name": name,
        "generation": generation,
        "compute_capability": [major, minor],  # list, not tuple, for JSON safety
        "vram_gb": round(vram_gb, 1),
        "dtype": dtype,        # torch.dtype -- for internal use (autocast)
        "dtype_str": dtype_str,  # str -- for /health JSON response
    }
```

This probe runs once inside `load_predictor` (before `build_sam2_video_predictor`),
and the result is stored as a module-level `_GPU_PROFILE`. The `run_job` function
replaces its hardcoded `torch.bfloat16` with `_GPU_PROFILE["dtype"]`.

**`/health` response.** Include `gpu_profile` in the `/health` JSON using the
JSON-safe fields (`name`, `generation`, `compute_capability`, `vram_gb`,
`dtype_str`). Never include the raw `torch.dtype` object directly in the response
dict -- it is not JSON-serializable and will cause a `TypeError` at `json.dumps`
time. The existing `RotoscopingStatus` TypeScript type gains an optional
`gpuProfile` field, and the Rust `RotoscopingStatus` struct in
`src-tauri/src/commands/rotoscoping.rs` needs a matching optional field (with
`#[serde(rename = "gpuProfile", skip_serializing_if = "Option::is_none")]`).

**Mac / CPU guard.** The `RuntimeError` from `_probe_gpu` propagates out of
`load_predictor`. The startup sequence in `main.py` catches it, logs it at
`CRITICAL`, and exits the process with a clear error message:

```
FATAL: This rotoscoping service requires a CUDA GPU. Mac (MPS) and
CPU-only environments are not supported. Exiting.
```

The Tauri health-check will see the service as unavailable, and the
`RotoscopingUnavailableView` in the workspace will show the service is not
running, with the log error accessible in the service's log file.

**SAM2 build flags.** On Ada (sm_89), Hopper (sm_90), and Blackwell (sm_100+),
the SAM2 predictor supports `use_flash_attn=True` (FlashAttention-2 / SDPA). On
Ampere and below the flag defaults to `False`. The probe can gate this:

```python
use_flash = _GPU_PROFILE["generation"] in ("ada", "hopper", "blackwell")
try:
    predictor = build_sam2_video_predictor(
        config.SAM2_CONFIG_NAME,
        str(config.CHECKPOINT_PATH),
        device="cuda",
        use_flash_attn=use_flash,
    )
except ImportError:
    # flash-attn package not installed; fall back to standard attention.
    logger.warning(
        "flash-attn not available on this system; building without FlashAttention"
    )
    predictor = build_sam2_video_predictor(
        config.SAM2_CONFIG_NAME,
        str(config.CHECKPOINT_PATH),
        device="cuda",
        use_flash_attn=False,
    )
```

Catch `ImportError` specifically, not bare `Exception`, so genuine SAM2 build
errors (wrong checkpoint path, config mismatch) are not silently swallowed.

**`CHUNK_SIZE` default by GPU.** Larger VRAM warrants larger chunks (fewer
init/reset cycles, slightly better throughput). The default `CHUNK_SIZE = 150` in
`config.py` is appropriate for 16GB; an environment override already exists. No
automatic tuning is needed -- document the relationship in a comment in `config.py`
so an operator on a 24GB card knows to try `ROTO_CHUNK_SIZE=300`.

**Files:** `microservices/rotoscoping/sam2_engine.py` (`_probe_gpu`,
`load_predictor`, `run_job`), `microservices/rotoscoping/main.py`
(`/health` response), `microservices/rotoscoping/config.py` (CHUNK_SIZE comment).
TypeScript: `src/types/roto.ts` (`RotoscopingStatus.gpuProfile` optional field).
Rust: `src-tauri/src/commands/rotoscoping.rs` (add `gpu_profile` optional field to
`RotoscopingStatus` struct with camelCase serde rename).

---

## 2. Auto color theme (follow OS system preference)

**Problem.** The Settings pane offers "Light" and "Dark" toggle buttons but no
"Auto" option. Users who switch their OS between dark and light mode have to
manually follow suit in the app.

**Proposed UX.** Add a third segment button "Auto" to the theme selector in
`Settings.tsx`. When "Auto" is selected:
- The displayed theme tracks the OS `prefers-color-scheme` media query.
- Switching the OS theme updates the app theme in real time via a
  `matchMedia` `change` listener.
- `localStorage` stores `"auto"` so the preference persists across restarts.

**`themeStore` changes.**

```ts
export type Theme = "light" | "dark" | "auto";

// The resolved theme applied to the DOM is always "light" or "dark".
function resolveTheme(pref: Theme): "light" | "dark" {
  if (pref === "auto") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  return pref;
}

function applyTheme(pref: Theme) {
  document.documentElement.setAttribute("data-theme", resolveTheme(pref));
}
```

The store gains a `preference: Theme` field (what the user picked, including
`"auto"`) alongside the existing `theme` field (the resolved `"light" | "dark"`
actually applied). All code that reads `theme` for rendering (Monaco, xterm) uses
the resolved field unchanged.

On `setTheme("auto")`, register a `matchMedia` listener that calls
`setTheme("auto")` again on system theme change -- this re-resolves and re-applies
the theme automatically:

```ts
setTheme: (pref) => {
  // Remove any previous listener.
  if (_mqlListener) {
    _mediaQuery.removeEventListener("change", _mqlListener);
    _mqlListener = null;
  }
  if (pref === "auto") {
    _mqlListener = () => applyTheme("auto");
    _mediaQuery.addEventListener("change", _mqlListener);
  }
  applyTheme(pref);
  localStorage.setItem(STORAGE_KEY, pref);
  set({ preference: pref, theme: resolveTheme(pref) });
},
```

`readStored` currently guards with `if (v === "light" || v === "dark") return v`,
which means a stored `"auto"` value is silently discarded and the user gets the
OS-resolved theme with no "Auto" button highlighted. Add `"auto"` to the guard:

```ts
if (v === "light" || v === "dark" || v === "auto") return v as Theme;
```

Without this fix, the "Auto" preference is lost on every restart — a confusing
regression where the setting appears to save but doesn't.

**`Settings.tsx` change.** Add `"auto"` to the `Theme[]` map in the segment
control, with a system-icon (a monitor or `"A"` label). Subscribe to `preference`
(not `theme`) to drive the active highlight -- `theme` is the resolved value and
would highlight both the resolved-theme button and the Auto button simultaneously
when Auto is selected:

```tsx
// Correct: read preference for the active check, theme for downstream consumers.
const preference = useThemeStore((s) => s.preference);
const setTheme = useThemeStore((s) => s.setTheme);

{(["light", "dark", "auto"] as Theme[]).map((t) => (
  <button ... style={segBtn(preference === t)} onClick={() => setTheme(t)}>
    {t === "auto" ? <AutoIcon /> : t === "light" ? <SunIcon /> : <MoonIcon />}
    {t === "auto" ? "Auto" : t === "light" ? "Light" : "Dark"}
  </button>
))}
```

`segBtn(preference === t)` correctly highlights exactly one button regardless of
which theme the OS resolves to.

**Files:** `src/store/themeStore.ts`, `src/components/Settings.tsx`.

---

## Implementation order

1. **Section 2** (auto theme) -- pure frontend, no backend dep. Trivial.
   The `themeStore` change is self-contained; `Settings.tsx` is additive.

2. **Section 1** (GPU probe) -- backend-only change. The most impactful item for
   production stability on 40-series and 50-series hardware. The Mac guard should
   land first (as a safety net), then the dtype/TF32 selection, then the
   FlashAttention gating (since it requires `flash-attn` to be present on the
   target box to verify).
