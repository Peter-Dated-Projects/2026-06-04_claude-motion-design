---
id: shared-tree-git-add-all-sweeps-other-workers
root: gotchas
type: gotcha
status: current
summary: "On charm's shared single tree, a worker that stages with `git add -A`/`git add .` sweeps up other in-flight workers' uncommitted edits into its own commit; always commit with explicit pathspecs."
created: 2026-06-04
updated: 2026-06-04
---

Charm runs every worker on ONE shared git working tree (no per-worker
worktrees). All workers' uncommitted edits coexist in the same index/worktree
at the same time.

If a worker stages broadly -- `git add -A`, `git add .`, or `git commit -a` --
it picks up every dirty file in the tree, including files another worker has
edited but not yet committed. Those edits then land in the wrong commit under
the wrong ticket's message.

Observed on T-001: the T-001 CSS work (App.css, ExportMenu.tsx, ProjectMenu.tsx)
was staged, but before it committed, T-002 committed with broad staging and
swept all three files into commit aee9bc3 ("T-002: ... bezel"). The T-001 code
was intact in HEAD -- just mis-attributed -- and T-001's own `git commit`
then reported "nothing staged."

How to avoid:
- Always stage AND commit with explicit pathspecs for only your ticket's
  `touches` files: `git add <paths>` then `git commit -- <paths>`. The pathspec
  on the commit itself is the real guard -- it commits only those paths even if
  other files are staged.
- Never use `git add -A`, `git add .`, or `git commit -a` in a charm worker.
- If your commit reports "nothing staged," check `git show --stat HEAD`: your
  work may already be in someone else's commit. The code is not lost; don't
  re-apply it.
