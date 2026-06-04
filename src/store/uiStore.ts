import { create } from "zustand";

export type SafeZonePlatform = "universal" | "tiktok" | "instagram" | "youtube";

export interface Selection {
  text: string;
  startLine: number;
  endLine: number;
}

export interface UIState {
  /** Panel widths as percentages [chat, code, preview]; always sums to ~100. */
  panelWidths: [number, number, number];
  isGenerating: boolean;
  showSafeZone: boolean;
  safeZonePlatform: SafeZonePlatform;
  selection: Selection | null;

  setPanelWidths: (widths: [number, number, number]) => void;
  setIsGenerating: (value: boolean) => void;
  toggleSafeZone: () => void;
  setSafeZonePlatform: (platform: SafeZonePlatform) => void;
  setSelection: (selection: Selection | null) => void;
}

const PANEL_WIDTHS_KEY = "claude-motion:panelWidths";
const DEFAULT_WIDTHS: [number, number, number] = [25, 37, 38];

function loadPanelWidths(): [number, number, number] {
  try {
    const raw = localStorage.getItem(PANEL_WIDTHS_KEY);
    if (!raw) return DEFAULT_WIDTHS;
    const parsed = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.length === 3 &&
      parsed.every((n) => typeof n === "number" && Number.isFinite(n))
    ) {
      return parsed as [number, number, number];
    }
  } catch {
    // Corrupt or unavailable storage -> fall back to defaults.
  }
  return DEFAULT_WIDTHS;
}

function persistPanelWidths(widths: [number, number, number]): void {
  try {
    localStorage.setItem(PANEL_WIDTHS_KEY, JSON.stringify(widths));
  } catch {
    // Best-effort; ignore quota/availability errors.
  }
}

export const useUIStore = create<UIState>((set) => ({
  panelWidths: loadPanelWidths(),
  isGenerating: false,
  showSafeZone: true,
  safeZonePlatform: "universal",
  selection: null,

  setPanelWidths: (widths) => {
    persistPanelWidths(widths);
    set({ panelWidths: widths });
  },
  setIsGenerating: (value) => set({ isGenerating: value }),
  toggleSafeZone: () => set((state) => ({ showSafeZone: !state.showSafeZone })),
  setSafeZonePlatform: (platform) => set({ safeZonePlatform: platform }),
  setSelection: (selection) => set({ selection }),
}));
