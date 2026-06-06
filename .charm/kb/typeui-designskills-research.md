---
id: typeui-designskills-research
root: research
type: research
status: current
summary: "typeui.sh is a static-web-UI design system platform; minimal overlap with Remotion vertical-video use case — specific takeaways documented."
created: 2026-06-05
updated: 2026-06-05
---

# Research: typeui.sh/design-skills

Ticket: T-057
Date: 2026-06-05
Researcher: worker-002

---

## 1. What the site is

typeui.sh is a curated library of UI design systems and layout prompts for AI coding tools (Claude, Cursor, Codex, Grok, etc.). It provides:

- **67 design "skills"** — named visual aesthetics (Glassmorphism, Neobrutalism, Premium, Bold, Paper, Neumorphism, Bento, Perspective, Artistic, Clean, Refined, Cafe, etc.) each expressed as a markdown design system doc with color tokens, typography guidance, spacing, and component conventions.
- **328 UI layout prompts** — static layout patterns for marketing pages (hero sections, pricing, CTAs, testimonials) and app interfaces (sidebars, modals, tables, dashboards). No motion or animation prompts.
- **MCP integration** — a server that injects the active design system into the AI coding session at generation time. Workflow: pick a design skill -> publish it as a design system -> AI tools consume it via MCP context.
- **Documentation** focused entirely on tool integration workflow, not on design theory or animation.

**Core purpose**: make AI-generated static web UIs look consistent and intentional by supplying structured design context upfront.

---

## 2. Overlap with remotion-skills.txt

**Already well covered in remotion-skills.txt:**

| typeui.sh pattern | remotion-skills.txt equivalent | verdict |
|---|---|---|
| Role-based color tokens (Primary, Secondary, Surface, Text) | Named palettes with roles (bg, surface, accent, accent-soft, ink, muted) | Remotion approach is better-fitted to video: fewer roles, clearer hierarchy |
| Typography scale (px sizes + weights) | Full type scale table with px sizes, weights, tracking, line-height, and use cases | Remotion table is richer and video-specific |
| Spacing base unit (4px grid) | 8px base grid with named scale | Both fine; remotion's 8px base is more appropriate for large-canvas 1080x1920 |
| Named visual aesthetics | Named palettes (P1 Midnight Pop, P2 Warm Charcoal, etc.) | Same concept, both cover this |
| One clear hierarchy principle | "Exactly one hero per scene" rule | Same principle, remotion is more explicit |

**Not present in typeui.sh at all** (remotion-skills.txt gap analysis is a non-issue here):
- Motion, animation, spring physics, easing curves — absent from typeui.sh entirely
- Frame timing, stagger patterns, Remotion primitives — absent
- Vertical video safe zones, platform UI masks — absent
- Enter/hold/exit phase budgets — absent
- Anti-patterns for animation — absent

typeui.sh has no overlap with the motion and video-specific content that makes up the majority of remotion-skills.txt.

---

## 3. Specific content worth examining

### 3a. Named aesthetic "skill" framing (low value for Remotion)

typeui.sh organizes visual styles as named, browsable "skills" (one per aesthetic). Each skill is a self-contained design system doc. This framing is interesting but remotion-skills.txt already implements the same concept differently (named palettes P1-P6, named motion presets snappy-entrance/smooth-settle/etc., named templates T1-T10). The typeui framing doesn't add anything new.

### 3b. Neobrutalism hard-shadow technique (minor CSS idea)

Neobrutalism skill specifies: "hard shadows use 4-6px offset in both axes with no blur for a paper-cutout effect." In CSS: `box-shadow: 4px 4px 0 #000`. This is a valid stylistic option for Remotion surface panels (div cards, stat boxes) that isn't currently named or described in remotion-skills.txt. It could be added as an optional surface treatment variation under the aesthetic palette system.

### 3c. Glassmorphism backdrop-blur specs (not applicable to Remotion)

typeui.sh specifies glassmorphism blur levels (8-12px light, 16-20px medium, 24-32px heavy) using CSS `backdrop-filter: blur()`. This does NOT apply to Remotion: Remotion renders frames as static images/video, and `backdrop-filter` is not reliably supported in Remotion's headless Chromium renderer. Not worth adapting.

### 3d. prefers-reduced-motion mention (not applicable)

typeui.sh mentions respecting `prefers-reduced-motion` for accessibility. Irrelevant for Remotion: exported video clips are not interactive media and have no runtime media query context.

### 3e. WCAG 2.2 AA contrast enforcement (informational only)

typeui.sh mandates WCAG 2.2 AA contrast. remotion-skills.txt already handles contrast through the palette rules (ink on bg for body, accent only for one word/shape where contrast allows). No addition needed, but the explicit contrast standard framing could be a minor documentation enhancement if contrast auditing is ever desired.

---

## 4. What to skip

Everything else on typeui.sh is irrelevant to remotion-skills.txt:

- **UI layout prompts** (hero sections, sidebars, modals, tables) — these are static web layouts, not animation compositions
- **MCP integration workflow** — unrelated to the remotion-skills.txt prompt system
- **Specific typeface recommendations** (Plus Jakarta Sans, JetBrains Mono, Inter) — these require font loading and are blocked by the remotion-skills.txt import constraint (no Google Fonts / @font-face, system fonts only)
- **Component-level design specs** (buttons, inputs, navigation) — web UI components, not video design elements
- **Interactive state documentation** (hover, focus, active, disabled) — inapplicable to video
- **4px base spacing grid** — remotion-skills.txt uses 8px which is better scaled for 1080x1920

---

## 5. Summary verdict

**typeui.sh is the wrong reference for Remotion animation improvement.** It is a static web UI design system platform with zero motion design content. The design system patterns it documents (color tokens, type scales, spacing grids, component rules) are already covered in remotion-skills.txt at a higher level of video-specific precision.

The one minor, concrete takeaway: the neobrutalism hard-shadow technique (`box-shadow: Npx Npx 0 color` with no blur) is a valid CSS stylistic option for Remotion surface panels that could be noted as an optional aesthetic variant under "surface treatments" in remotion-skills.txt. It is not a gap but a missing named option.

**Do not use typeui.sh as a reference for updating remotion-skills.txt.** The gap analysis in T-056 (freshtechbro/claudedesignskills) is more likely to yield relevant animation patterns — that repo is specifically a Claude design skills prompt library, not a static UI platform.
