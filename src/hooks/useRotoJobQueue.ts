import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useRotoStore } from "../store/rotoStore";
import type {
  RotoProgress,
  RotoscopeParams,
  RotoscopeResult,
} from "../types/roto";

/**
 * Client-side rotoscope job queue: lets the user stack multiple rotoscope
 * requests and keep working while they run. Jobs are sent to the backend one at
 * a time, in submission order -- the backend already serializes on a single-GPU
 * lock, so the queue's job is to (a) hold the not-yet-sent requests, (b) never
 * fire a second `rotoscope_video` until the previous one settles, and (c) drive
 * the bottom-left overlay's card stack.
 *
 * This hook OWNS the side effects (the `roto://progress` listener, the
 * `trim_video` / `rotoscope_video` / `cancel_rotoscope` invokes) that the rest of
 * the rotoscoping UI used to run inline in RotoVideoPanel. The pure rotoStore is
 * still fed through its documented actions (`startJob` / `jobComplete` /
 * `setError`) so the in-pane ProcessingView, done banner, and Outputs list keep
 * working for the active job exactly as before -- the queue is a progressive
 * enhancement layered over that single-job flow, not a replacement for it.
 *
 * Single instance: mount it once via `RotoJobQueueProvider` (in App.tsx) and read
 * it from both RotoVideoPanel (enqueue / cancel) and RotoJobQueueOverlay (jobs /
 * cancel / dismiss) through `useRotoJobQueueApi`. Calling the hook in two places
 * would create two independent queues.
 */

/** Mirrors App.tsx / RotoVideoPanel's ROTO_HOST_KEY -- the LAN host of the service. */
const ROTO_HOST_KEY = "claude-motion:rotoHost";

/** How long a finished card lingers before it auto-removes. */
const DONE_LINGER_MS = 2000;
/** Brief fade window for a cancelled card before it is dropped from the stack. */
const CANCEL_FADE_MS = 300;

export type QueuedJobStatus =
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "cancelled";

export interface QueuedJob {
  /** Client-generated id; threaded into the backend as the job id for cancel. */
  id: string;
  /** Display label, e.g. "clip.mp4 (frame 42)". */
  label: string;
  status: QueuedJobStatus;
  /** 0..1, driven by `roto://progress` while running. */
  progress: number;
  error: string | null;
  params: RotoscopeParams;
}

export interface RotoJobQueueApi {
  jobs: QueuedJob[];
  /** Append a job (and start it if nothing is running). Returns its id. */
  enqueue: (params: RotoscopeParams, label: string) => string;
  /** Cancel a queued job (drops it) or a running job (cancels the backend run). */
  cancel: (id: string) => void;
  /** Remove a finished ("done"/"failed") card from the visible stack. */
  dismiss: (id: string) => void;
}

function newJobId(): string {
  return `roto-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function useRotoJobQueue(): RotoJobQueueApi {
  const [jobs, setJobs] = useState<QueuedJob[]>([]);

  // `jobsRef` mirrors `jobs` synchronously so the (stable) callbacks below can
  // read the current list without going stale between an enqueue and the async
  // run that follows it. Every mutation goes through `commit`, which updates the
  // ref first and then the state, keeping the two in lockstep.
  const jobsRef = useRef<QueuedJob[]>(jobs);
  const commit = useCallback(
    (updater: (prev: QueuedJob[]) => QueuedJob[]) => {
      const next = updater(jobsRef.current);
      jobsRef.current = next;
      setJobs(next);
    },
    [],
  );

  // Per-job pending auto-remove timers (done cards linger, cancelled cards fade),
  // so `dismiss` / unmount can clear them before they fire.
  const autoRemoveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>(
    {},
  );
  // Ids cancelled while their run is still in flight. `_processNext` checks this
  // after `trim_video` resolves (to skip the heavy `rotoscope_video` invoke) and
  // the catch path checks it (to avoid marking a deliberately-cancelled job as
  // failed). The rotoscope_video promise for a cancelled job rejects once the
  // backend tears the run down; both paths converge here.
  const cancelledIds = useRef<Set<string>>(new Set());

  // processNext <-> runJob are mutually recursive; route the back-reference
  // through a ref so both can stay stable (empty-dep) callbacks.
  const processNextRef = useRef<() => void>(() => {});

  const scheduleRemove = useCallback(
    (id: string, delay: number) => {
      autoRemoveTimers.current[id] = setTimeout(() => {
        delete autoRemoveTimers.current[id];
        commit((prev) => prev.filter((j) => j.id !== id));
      }, delay);
    },
    [commit],
  );

  const runJob = useCallback(
    async (job: QueuedJob) => {
      const { params } = job;
      const host = localStorage.getItem(ROTO_HOST_KEY) || "localhost";
      try {
        let sourcePath = params.sourcePath;
        let effectiveStartFrame = params.startFrame;

        // Trim step: when a clip range is set, trim the source first and rebase
        // the reference frame onto the trimmed clip (the trim drops the first
        // `clipStart` seconds; rotoscope_video re-clips with gte(n, startFrame)
        // on whatever file it receives). Points are spatial coords and unaffected.
        if (params.clipStart != null && params.clipEnd != null) {
          sourcePath = await invoke<string>("trim_video", {
            path: params.sourcePath,
            startSecs: params.clipStart,
            endSecs: params.clipEnd,
          });
          // Cancelled mid-trim: bail before the heavy invoke and free the queue.
          if (cancelledIds.current.has(job.id)) {
            cancelledIds.current.delete(job.id);
            processNextRef.current();
            return;
          }
          effectiveStartFrame = Math.max(
            0,
            params.startFrame - Math.round(params.clipStart * params.fps),
          );
        }

        const result = await invoke<RotoscopeResult>("rotoscope_video", {
          slug: params.slug,
          host,
          sourcePath,
          jobId: job.id,
          startFrame: effectiveStartFrame,
          points: params.points,
          frameSkip: params.frameSkip,
          compress: params.compress,
          quality: params.quality,
        });

        commit((prev) =>
          prev.map((j) =>
            j.id === job.id ? { ...j, status: "done", progress: 1 } : j,
          ),
        );
        useRotoStore.getState().jobComplete(result);
        scheduleRemove(job.id, DONE_LINGER_MS);
        processNextRef.current();
      } catch (err) {
        // A cancellation surfaces here as a rejected rotoscope_video promise --
        // don't mark it failed, just move on (the card is already "cancelled").
        if (cancelledIds.current.has(job.id)) {
          cancelledIds.current.delete(job.id);
          processNextRef.current();
          return;
        }
        const message =
          typeof err === "string" ? err : `Rotoscope failed: ${String(err)}`;
        commit((prev) =>
          prev.map((j) =>
            j.id === job.id ? { ...j, status: "failed", error: message } : j,
          ),
        );
        useRotoStore.getState().setError(message);
        processNextRef.current();
      }
    },
    [commit, scheduleRemove],
  );

  const processNext = useCallback(() => {
    // Re-entrancy guard: at most one backend job in flight. Two rapid enqueues
    // (or an enqueue racing a completion) must not start two concurrent runners.
    if (jobsRef.current.some((j) => j.status === "running")) return;
    const job = jobsRef.current.find((j) => j.status === "queued");
    if (!job) return;
    commit((prev) =>
      prev.map((j) => (j.id === job.id ? { ...j, status: "running" } : j)),
    );
    // Keep the rotoStore's single-job view in sync for the in-pane UI.
    useRotoStore.getState().startJob(job.id);
    void runJob({ ...job, status: "running" });
  }, [commit, runJob]);

  useEffect(() => {
    processNextRef.current = processNext;
  }, [processNext]);

  const enqueue = useCallback(
    (params: RotoscopeParams, label: string): string => {
      const id = newJobId();
      const job: QueuedJob = {
        id,
        label,
        status: "queued",
        progress: 0,
        error: null,
        params,
      };
      commit((prev) => [...prev, job]);
      processNext();
      return id;
    },
    [commit, processNext],
  );

  const cancel = useCallback(
    (id: string) => {
      const job = jobsRef.current.find((j) => j.id === id);
      if (!job) return;
      if (job.status === "queued") {
        commit((prev) => prev.filter((j) => j.id !== id));
        return;
      }
      if (job.status === "running") {
        // Flag it so the in-flight run (mid-trim or mid-rotoscope) bails instead
        // of completing or reporting failure, then ask the backend to tear down.
        cancelledIds.current.add(id);
        const host = localStorage.getItem(ROTO_HOST_KEY) || "localhost";
        void invoke("cancel_rotoscope", { host, jobId: id }).catch(() => {
          // Best-effort: the job may already be gone. The card is dropped regardless.
        });
        commit((prev) =>
          prev.map((j) => (j.id === id ? { ...j, status: "cancelled" } : j)),
        );
        scheduleRemove(id, CANCEL_FADE_MS);
        // Free the queue for the next job; the cancelled run's promise will
        // reject into runJob's catch, which sees `cancelledIds` and no-ops.
        processNext();
      }
    },
    [commit, processNext, scheduleRemove],
  );

  const dismiss = useCallback(
    (id: string) => {
      const t = autoRemoveTimers.current[id];
      if (t) {
        clearTimeout(t);
        delete autoRemoveTimers.current[id];
      }
      commit((prev) => prev.filter((j) => j.id !== id));
    },
    [commit],
  );

  // Progress ticks have no jobId (the event payload is just stage/progress).
  // Because the backend runs one job at a time, every tick belongs to the
  // currently running job -- match it by status, not by id.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void listen<RotoProgress>("roto://progress", (e) => {
      if (disposed) return;
      const p = e.payload.progress;
      if (p == null) return;
      commit((prev) =>
        prev.map((j) => (j.status === "running" ? { ...j, progress: p } : j)),
      );
    }).then((un) => {
      if (disposed) un();
      else unlisten = un;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [commit]);

  // Clear any pending timers on unmount.
  useEffect(() => {
    const timers = autoRemoveTimers.current;
    return () => {
      for (const t of Object.values(timers)) clearTimeout(t);
    };
  }, []);

  return { jobs, enqueue, cancel, dismiss };
}

// --- Shared single instance via context ------------------------------------

const RotoJobQueueContext = createContext<RotoJobQueueApi | null>(null);

/**
 * Owns the one queue instance. Mount once near the app root so RotoVideoPanel and
 * RotoJobQueueOverlay -- which live in different parts of the tree -- share it.
 * Written with `createElement` (not JSX) so this stays a `.ts` module.
 */
export function RotoJobQueueProvider({ children }: { children: ReactNode }) {
  const api = useRotoJobQueue();
  return createElement(RotoJobQueueContext.Provider, { value: api }, children);
}

/** Read the shared queue. Throws if used outside `RotoJobQueueProvider`. */
export function useRotoJobQueueApi(): RotoJobQueueApi {
  const api = useContext(RotoJobQueueContext);
  if (!api) {
    throw new Error(
      "useRotoJobQueueApi must be used within a RotoJobQueueProvider",
    );
  }
  return api;
}
