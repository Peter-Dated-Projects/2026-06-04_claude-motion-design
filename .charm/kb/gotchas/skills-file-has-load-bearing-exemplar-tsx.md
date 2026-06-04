---
id: skills-file-has-load-bearing-exemplar-tsx
root: gotchas
type: gotcha
status: current
summary: "remotion-skills.txt now embeds a complete exemplar animation.tsx (the few-shot 'what good looks like' anchor); it must stay a compiling Remotion file or it teaches the model broken patterns -- verify by extracting the block and running tsc against the project's node_modules."
related:
  - gotchas/skills-prompt-cached-write-if-absent
  - gotchas/canonical-canvas-is-vertical
created: 2026-06-04
updated: 2026-06-04
---

The rewritten `src-tauri/resources/remotion-skills.txt` (T-047) is no longer a
pure rules file. Section 9 embeds a full, complete `animation.tsx` as a few-shot
exemplar -- the "what good looks like" anchor the model pattern-matches onto. It
uses the default look (Midnight Pop palette, Bold Impact headline, Kinetic
Staggered Headline, snappy-entrance + gentle-float + soft-exit).

The trap: this exemplar is prose inside a `.txt`, so the project's `bunx tsc
--noEmit` does NOT type-check it. A broken exemplar compiles fine from the build's
point of view but actively teaches Claude wrong patterns (worse than no example).
If you edit the exemplar, you must verify it by hand.

How to verify the embedded exemplar still compiles (it spans the two sentinel
lines `import React from "react";` ... `export default MotionThatMoves;`):

```
awk '/^import React from "react";$/{f=1} f{print} /^export default MotionThatMoves;$/{f=0}' \
  src-tauri/resources/remotion-skills.txt > _exemplar_check.tsx
bunx tsc --noEmit --jsx react-jsx --skipLibCheck --moduleResolution bundler \
  --module esnext --target es2020 --strict --esModuleInterop ./_exemplar_check.tsx
rm -f ./_exemplar_check.tsx
```

It must be run from the project root so the temp file resolves `react`/`remotion`
from the project's `node_modules` (running it in `/tmp` only yields TS2307
module-not-found noise). Clean output = the exemplar is sound.

Subtlety worth keeping: the exemplar declares `export const fps = 30` at module
level AND destructures `const { fps } = useVideoConfig()` inside the component.
The local binding shadows the export -- intentional and correct (the export
drives the composition; useVideoConfig reads it back at runtime). Don't "fix" it.
