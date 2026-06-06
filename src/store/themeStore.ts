import { create } from "zustand";

// App-wide light/dark theme. The actual colors live as CSS custom properties in
// App.css (`:root` for light, `:root[data-theme="dark"]` for dark); this store
// only flips the `data-theme` attribute on <html> and remembers the choice in
// localStorage. Surfaces that aren't plain CSS (Monaco, xterm) subscribe to
// `theme` and re-skin themselves.

export type Theme = "light" | "dark";

const STORAGE_KEY = "claude-motion.theme";

function readStored(): Theme {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark") return v;
  } catch {
    // localStorage can throw in locked-down webviews; fall through to OS pref.
  }
  if (window.matchMedia?.("(prefers-color-scheme: dark)").matches) return "dark";
  return "light";
}

function applyTheme(theme: Theme) {
  document.documentElement.setAttribute("data-theme", theme);
}

interface ThemeState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: readStored(),
  setTheme: (theme) => {
    applyTheme(theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Persistence is best-effort; the in-memory theme still applies.
    }
    set({ theme });
  },
  toggleTheme: () => get().setTheme(get().theme === "dark" ? "light" : "dark"),
}));

// Apply the stored theme at module load (before first paint) to avoid a flash of
// the wrong palette.
applyTheme(useThemeStore.getState().theme);
