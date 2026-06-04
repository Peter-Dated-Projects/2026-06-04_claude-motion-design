---
id: monaco-cdn-offline-loader
root: gotchas
type: gotcha
status: current
summary: "@monaco-editor/react fetches Monaco from a CDN by default; the offline desktop app must loader.config({ monaco }) against the bundled monaco-editor and wire workers via Vite ?worker imports."
related:
  - architecture/preview-sandbox
created: 2026-06-04
updated: 2026-06-04
---

`@monaco-editor/react` does NOT bundle the Monaco editor. By default its `loader`
fetches the runtime from a jsDelivr CDN at first render. That works in `vite dev`
on a connected machine and silently passes CI builds — but the packaged Tauri app
is offline, so the editor would just spin forever with no obvious error.

Fix (done in `src/components/CodePanel/MonacoEditor.tsx`):

```ts
import Editor, { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

self.MonacoEnvironment = {
  getWorker(_id, label) {
    if (label === "typescript" || label === "javascript") return new tsWorker();
    return new editorWorker();
  },
};
loader.config({ monaco }); // use the bundled copy, never the CDN
```

Two halves, both required:
- `loader.config({ monaco })` hands @monaco-editor/react the locally-installed
  `monaco-editor` instead of letting it CDN-fetch one.
- `self.MonacoEnvironment.getWorker` must return Monaco's web workers. The TS
  worker is what powers JSX/TSX language features; without it the editor renders
  but has no IntelliSense/validation. Vite's `?worker` suffix bundles each worker
  as a local chunk.

Keep all of this inside a module that is only reached via a dynamic `import()`
(CodePanel lazy-loads MonacoEditor). Monaco is ~3.8MB minified; lazy-loading keeps
it out of the initial app bundle. Verify with `vite build`: you should see a
separate `MonacoEditor-*.js` chunk plus the worker chunks, not Monaco folded into
`index-*.js`.

Side note: the default `monaco-editor` import pulls in ALL ~80 language
definitions as lazy chunks (we only use typescript). They don't bloat the initial
load, but if total package size ever matters, slim it with the
`monaco-editor/esm/vs/...` feature/language imports or `vite-plugin-monaco-editor`.
