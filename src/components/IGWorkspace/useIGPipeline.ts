import { useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useIGStore } from "../../store/igStore";
import { useProjectStore } from "../../store/projectStore";
import type { ProjectFile } from "../../types";
import type {
  Brief,
  ClipResult,
  DownloadResult,
  IGExtractionListItem,
  PhaseAInput,
  ScoreResult,
  StageProgress,
} from "../../types/ig";

/**
 * The single Tauri <-> IG-store bridge: the one place `invoke`/`listen` cross the
 * boundary for the Instagram workspace. The store (igStore.ts) and the four IG
 * panels are deliberately Tauri-free / pure; this hook is what makes them live.
 *
 * It does three things:
 *
 *   1. Routes the three backend events into the store's pure apply-event reducers
 *      (ig://stage-progress -> applyStageProgress, ig://score -> applyFrameScore
 *      per frame, ig://brief -> setBrief). No reducer logic lives here.
 *
 *   2. Decorates the store's three *trigger* actions (startPhaseA / startPhaseB /
 *      setActiveExtraction) with their Tauri side effects. The store keeps these
 *      as pure state transitions (and intentionally DISCARDS startPhaseA's input),
 *      so the only way to fire the matching `invoke` -- and to recover the URL/
 *      file the user submitted -- is to wrap the action at runtime. We capture the
 *      originals on mount, swap in wrapped versions via `useIGStore.setState`, and
 *      restore them on unmount. The store FILE is never touched; it stays
 *      unit-testable in isolation.
 *
 *   3. Loads the project's past-extractions list for the sidebar, and on selecting
 *      a past row, reloads that extraction's video/frames/brief from disk.
 *
 * Mounted once, app-level (not gated on the active workspace) so a run started in
 * the IG stage keeps streaming into the store even after "Use as Style Reference"
 * switches the user to the main workspace, and so the wrapped actions persist.
 */

// --- Backend command shapes (camelCase, mirror ig_pipeline.rs) --------------

/** Return of `ig_extract_phase_a`. Carries the upstream results Phase B needs. */
interface PhaseAResult {
  download: DownloadResult;
  clip: ClipResult;
  scoreResult: ScoreResult;
}

/** Input to `ig_extract_phase_b`: Phase A results round-tripped + the chosen set. */
interface PhaseBInput {
  download: DownloadResult;
  clip: ClipResult;
  scoreResult: ScoreResult;
  keptFramePaths: string[];
}

/** Payload of the `ig://brief` event / return of `ig_extract_phase_b`: the brief,
 *  flattened, plus the finalized extraction folder. */
type BriefResult = Brief & { extractionDir: string };

// --- Helpers ----------------------------------------------------------------

/** The store's frame index -> store's 3-digit `frame_NNN.jpg` name (matches
 *  lib/paths.ts `frameFileName`, which the store stage writes on disk). */
function frameFileName(index: number): string {
  return `frame_${String(index).padStart(3, "0")}.jpg`;
}

/** Strip a trailing slash so `${dir}/clip.mp4` never doubles up. */
function trimDir(dir: string): string {
  return dir.replace(/\/+$/, "");
}

/** Last path segment (the `<date>_<id>` extraction folder name). */
function folderName(dir: string): string {
  const parts = trimDir(dir).split("/");
  return parts[parts.length - 1] ?? "";
}

/** Surface invoke errors verbatim, except the missing-toolchain sentinel which
 *  gets an actionable message (the backend returns the bare sentinel string). */
function formatErr(err: unknown): string {
  const msg =
    typeof err === "string"
      ? err
      : err instanceof Error
        ? err.message
        : String(err);
  if (msg === "TOOLCHAIN_MISSING") {
    return (
      "The Instagram toolchain (bun, yt-dlp, ffmpeg) isn't installed yet. " +
      "Install it, or run with those tools on your PATH."
    );
  }
  return msg;
}

export function useIGPipeline(): void {
  const slug = useProjectStore((s) => s.activeProject?.slug ?? null);

  // Stash Phase A's results so Phase B can round-trip them (the Rust backend is
  // stateless between the two commands).
  const phaseAResultRef = useRef<PhaseAResult | null>(null);
  // The extraction currently materialized in the store. Guards the reload path so
  // re-selecting the just-finished run (whose in-memory state is already correct)
  // doesn't trigger a redundant disk reload.
  const loadedIdRef = useRef<string | null>(null);
  // Flipped true on unmount so in-flight async callbacks become no-ops.
  const disposedRef = useRef(false);

  // --- Side-effect helpers (stable; read everything from getState at call time) ---

  const refreshExtractions = useCallback(
    async (forSlug: string, selectId: string | null) => {
      try {
        const list = await invoke<IGExtractionListItem[]>(
          "ig_list_extractions",
          { slug: forSlug },
        );
        if (disposedRef.current) return;
        useIGStore.getState().setExtractions(list);
        if (selectId != null) {
          // Mark loaded BEFORE selecting so the wrapped setActiveExtraction's
          // reload guard skips it (state is already correct in memory).
          loadedIdRef.current = selectId;
          useIGStore.getState().setActiveExtraction(selectId);
        }
      } catch (err) {
        // Non-fatal: the run still completed; the sidebar just won't refresh.
        console.error("ig_list_extractions failed:", err);
      }
    },
    [],
  );

  // Re-point the live (Phase A) media paths to the finalized extraction folder.
  // After Phase B's store runs, the `.work` copies the store still references were
  // moved into extractions/<date>_<id>/ and the work dir was deleted, so the
  // store's clip/source/frame paths now dangle. Re-point them (preserving each
  // frame's keep/reject/override) so the done-state video + grid resolve.
  const repointToExtractionDir = useCallback((extractionDir: string) => {
    const s = useIGStore.getState();
    const base = trimDir(extractionDir);
    if (s.clip) s.applyClipResult({ ...s.clip, clipPath: `${base}/clip.mp4` });
    if (s.source)
      s.applyDownloadResult({ ...s.source, sourcePath: `${base}/source.mp4` });
    for (const f of Object.values(s.frames)) {
      s.applyFrameScore({ ...f, path: `${base}/frames/${frameFileName(f.index)}` });
    }
  }, []);

  // Reload a PAST extraction from disk (sidebar click). Persisted state has no
  // per-frame scores, so frames come back as kept (no reject overlays) -- a
  // read-only historical view, not a re-run.
  const loadExtractionFromDisk = useCallback(
    async (forSlug: string, item: IGExtractionListItem) => {
      const base = trimDir(item.dir);
      const folder = folderName(item.dir);
      const s = useIGStore.getState();
      // Clear the prior active extraction's display. reset() preserves the
      // sidebar list AND activeExtractionId (already set by the caller).
      s.reset();
      s.applyDownloadResult({
        sourcePath: `${base}/source.mp4`,
        id: item.id,
        sourceUrl: item.sourceUrl,
        durationSeconds: 0,
        usedCookieFallback: false,
      });
      s.applyClipResult({
        clipPath: `${base}/clip.mp4`,
        originalDurationSeconds: 0,
        clippedDurationSeconds: 0,
        wasClipped: false,
      });

      // Frames: list_project_files traverses extractions/, so filter to this
      // extraction's frames. (No new backend command needed.)
      try {
        const files = await invoke<ProjectFile[]>("list_project_files", {
          slug: forSlug,
        });
        // Bail if disposed or the user switched extractions mid-load.
        if (disposedRef.current) return;
        if (useIGStore.getState().activeExtractionId !== item.id) return;
        const prefix = `extractions/${folder}/frames/`;
        const frameFiles = files
          .filter(
            (f) =>
              !f.isDir && f.path.startsWith(prefix) && /frame_\d+\.jpg$/.test(f.path),
          )
          .sort((a, b) => a.path.localeCompare(b.path));
        for (const f of frameFiles) {
          const m = f.path.match(/frame_(\d+)\.jpg$/);
          const index = m ? Number(m[1]) : 0;
          const name = f.path.split("/").pop() ?? "";
          useIGStore.getState().applyFrameScore({
            path: `${base}/frames/${name}`,
            index,
            sharpness: 0,
            delta: null,
            entropy: 0,
            score: 0,
            kept: true,
          });
        }
      } catch (err) {
        console.error("reload extraction frames failed:", err);
      }

      // Brief: read_file accepts a project-relative path under extractions/.
      try {
        const raw = await invoke<string>("read_file", {
          slug: forSlug,
          path: `extractions/${folder}/brief.json`,
        });
        if (disposedRef.current) return;
        if (useIGStore.getState().activeExtractionId !== item.id) return;
        if (raw) {
          useIGStore.getState().setBrief(JSON.parse(raw) as Brief); // -> phase done
        }
      } catch (err) {
        console.error("reload extraction brief failed:", err);
      }
    },
    [],
  );

  const doStartPhaseA = useCallback((input: PhaseAInput) => {
    const projectSlug = useProjectStore.getState().activeProject?.slug;
    if (!projectSlug) {
      useIGStore.getState().setError("Open a project before running an extraction.");
      return;
    }
    // A fresh run supersedes any selected past extraction.
    loadedIdRef.current = null;
    phaseAResultRef.current = null;
    const value = "url" in input ? input.url : input.filePath;
    invoke<PhaseAResult>("ig_extract_phase_a", { slug: projectSlug, input: value })
      .then((result) => {
        if (disposedRef.current) return;
        phaseAResultRef.current = result;
        const s = useIGStore.getState();
        s.applyDownloadResult(result.download);
        s.applyClipResult(result.clip);
        // Idempotent with the ig://score event; applying here too guarantees the
        // grid is populated before we transition to awaiting-review, regardless
        // of event-vs-return delivery order.
        for (const f of result.scoreResult.scored) s.applyFrameScore(f);
        s.phaseAComplete();
      })
      .catch((err) => {
        if (disposedRef.current) return;
        useIGStore.getState().setError(formatErr(err));
      });
  }, []);

  const doStartPhaseB = useCallback(() => {
    const projectSlug = useProjectStore.getState().activeProject?.slug;
    const phaseA = phaseAResultRef.current;
    if (!projectSlug || !phaseA) {
      useIGStore
        .getState()
        .setError("Phase A results are missing; re-run the extraction.");
      return;
    }
    const keptFramePaths = useIGStore.getState().keptFramePaths();
    const input: PhaseBInput = {
      download: phaseA.download,
      clip: phaseA.clip,
      scoreResult: phaseA.scoreResult,
      keptFramePaths,
    };
    invoke<BriefResult>("ig_extract_phase_b", { slug: projectSlug, input })
      .then((result) => {
        if (disposedRef.current) return;
        // The brief itself lands via the ig://brief event; here we fix up the
        // media paths to the finalized folder and refresh the sidebar so the new
        // run appears and becomes the active row.
        repointToExtractionDir(result.extractionDir);
        void refreshExtractions(projectSlug, phaseA.download.id);
      })
      .catch((err) => {
        if (disposedRef.current) return;
        useIGStore.getState().setError(formatErr(err));
      });
  }, [refreshExtractions, repointToExtractionDir]);

  const doSetActiveExtraction = useCallback(
    (id: string | null) => {
      if (id == null) return;
      if (id === loadedIdRef.current) return; // already materialized in the store
      const projectSlug = useProjectStore.getState().activeProject?.slug;
      if (!projectSlug) return;
      const item = useIGStore.getState().extractions.find((e) => e.id === id);
      if (!item) return;
      loadedIdRef.current = id;
      void loadExtractionFromDisk(projectSlug, item);
    },
    [loadExtractionFromDisk],
  );

  // --- Wire listeners + decorate the store actions (once) ---------------------
  useEffect(() => {
    disposedRef.current = false;

    // Capture the pure originals, then swap in side-effecting wrappers.
    const original = {
      startPhaseA: useIGStore.getState().startPhaseA,
      startPhaseB: useIGStore.getState().startPhaseB,
      setActiveExtraction: useIGStore.getState().setActiveExtraction,
    };
    useIGStore.setState({
      startPhaseA: (input) => {
        original.startPhaseA(input);
        doStartPhaseA(input);
      },
      startPhaseB: () => {
        original.startPhaseB();
        doStartPhaseB();
      },
      setActiveExtraction: (id) => {
        original.setActiveExtraction(id);
        doSetActiveExtraction(id);
      },
    });

    const unlisteners: UnlistenFn[] = [];
    const track = (p: Promise<UnlistenFn>) => {
      void p.then((un) => {
        if (disposedRef.current) un();
        else unlisteners.push(un);
      });
    };

    track(
      listen<StageProgress>("ig://stage-progress", (e) => {
        if (!disposedRef.current) useIGStore.getState().applyStageProgress(e.payload);
      }),
    );
    track(
      listen<ScoreResult>("ig://score", (e) => {
        if (disposedRef.current) return;
        for (const f of e.payload.scored) useIGStore.getState().applyFrameScore(f);
      }),
    );
    track(
      listen<BriefResult>("ig://brief", (e) => {
        if (disposedRef.current) return;
        const { extractionDir: _dir, ...brief } = e.payload;
        useIGStore.getState().setBrief(brief);
      }),
    );

    return () => {
      disposedRef.current = true;
      // Restore the pure store actions so a remount re-captures clean originals.
      useIGStore.setState(original);
      for (const un of unlisteners) un();
    };
  }, [doStartPhaseA, doStartPhaseB, doSetActiveExtraction]);

  // --- Per-project lifecycle: clear cross-project state + load the list -------
  useEffect(() => {
    loadedIdRef.current = null;
    phaseAResultRef.current = null;
    const s = useIGStore.getState();
    s.reset();
    s.setActiveExtraction(null); // wrapped; null is a no-op for the reload path
    s.setExtractions([]);
    if (slug) void refreshExtractions(slug, null);
  }, [slug, refreshExtractions]);
}

// Tiny mount host so App can render the bridge as an element without an extra file.
export default function IGPipelineHost(): null {
  useIGPipeline();
  return null;
}
