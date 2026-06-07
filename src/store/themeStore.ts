import { create } from "zustand";

// App-wide theme preference. "auto" follows the OS `prefers-color-scheme`;
// "light" and "dark" are explicit. The actual colors live as CSS custom
// properties in App.css (`:root` for light, `:root[data-theme="dark"]` for
// dark); this store only flips the `data-theme` attribute on <html> to the
// RESOLVED theme and remembers the PREFERENCE in localStorage. Surfaces that
// aren't plain CSS (Monaco, xterm) subscribe to `theme` -- the resolved
// "light" | "dark" -- and re-skin themselves.

export type Theme = "light" | "dark" | "auto";

const STORAGE_KEY = "claude-motion.theme";

// The OS color-scheme query, resolved once. Guarded because matchMedia can be
// absent in locked-down webviews; when it is, "auto" simply resolves to light.
const _mediaQuery =
  typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;

// The change-listener registered while the preference is "auto"; null otherwise.
let _mqlListener: (() => void) | null = null;

function readStored(): Theme {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark" || v === "auto") return v as Theme;
  } catch {
    // localStorage can throw in locked-down webviews; fall through to OS pref.
  }
  if (_mediaQuery?.matches) return "dark";
  return "light";
}

// The resolved theme applied to the DOM is always "light" or "dark".
function resolveTheme(pref: Theme): "light" | "dark" {
  if (pref === "auto") {
    return _mediaQuery?.matches ? "dark" : "light";
  }
  return pref;
}

function applyTheme(pref: Theme) {
  document.documentElement.setAttribute("data-theme", resolveTheme(pref));
}

// Register (or clear) the OS change-listener so a system theme switch re-resolves
// and re-applies in real time while following "auto". Idempotent: any previous
// listener is removed first, so this is safe to call on every setTheme.
function syncAutoListener(pref: Theme) {
  if (_mqlListener && _mediaQuery) {
    _mediaQuery.removeEventListener("change", _mqlListener);
    _mqlListener = null;
  }
  if (pref === "auto" && _mediaQuery) {
    _mqlListener = () => {
      applyTheme("auto");
      // Keep the resolved `theme` in sync so Monaco/xterm re-skin on OS change.
      useThemeStore.setState({ theme: resolveTheme("auto") });
    };
    _mediaQuery.addEventListener("change", _mqlListener);
  }
}

interface ThemeState {
  /** What the user picked, including "auto". Drives the settings highlight. */
  preference: Theme;
  /** The resolved theme actually applied to the DOM. Never "auto". */
  theme: "light" | "dark";
  setTheme: (pref: Theme) => void;
  toggleTheme: () => void;
}

export const useThemeStore = create<ThemeState>((set, get) => {
  const initial = readStored();
  return {
    preference: initial,
    theme: resolveTheme(initial),
    setTheme: (pref) => {
      syncAutoListener(pref);
      applyTheme(pref);
      try {
        localStorage.setItem(STORAGE_KEY, pref);
      } catch {
        // Persistence is best-effort; the in-memory theme still applies.
      }
      set({ preference: pref, theme: resolveTheme(pref) });
    },
    // Toggling flips the currently-resolved theme to an explicit choice (so it
    // leaves "auto" if that was active).
    toggleTheme: () => get().setTheme(get().theme === "dark" ? "light" : "dark"),
  };
});

// Apply the stored preference at module load (before first paint) to avoid a
// flash of the wrong palette, and register the OS listener when following
// "auto". Routed without persisting, so an absent preference still defers to the
// OS on the next launch instead of freezing the first-resolved value.
syncAutoListener(useThemeStore.getState().preference);
applyTheme(useThemeStore.getState().preference);
