---
name: Universal LLM Client documentation site
description: Neutral grounds, hairline rules and one signal green for a serious library site.
colors:
  signal: "#05704f"
  signal-hover: "#045c41"
  signal-active: "#034a34"
  signal-wash: "rgba(5, 112, 79, 0.1)"
  on-signal: "#ffffff"
  ground: "#ffffff"
  ground-alt: "#f5f6f6"
  ink: "#0c0f0e"
  ink-dim: "#474f4c"
  ink-faint: "#636b68"
  rule-strong: "#c6ccc9"
  rule: "#e1e5e3"
  inline-code-fill: "rgba(12, 15, 14, 0.06)"
  code-value: "#33506f"
  state-fail: "#b3261e"
  state-move: "#7a5200"
  dark-signal: "#3ddc97"
  dark-signal-hover: "#6ee7b0"
  dark-signal-active: "#2fc586"
  dark-signal-deep: "#12a16b"
  dark-signal-wash: "rgba(61, 220, 151, 0.14)"
  dark-on-signal: "#04130c"
  dark-ground: "#0b0d0c"
  dark-ground-alt: "#101312"
  dark-ground-soft: "#131716"
  dark-ground-raised: "#151918"
  dark-gutter: "#060807"
  dark-ink: "#eef1ef"
  dark-ink-dim: "#a9b1ad"
  dark-ink-faint: "#838c88"
  dark-rule-strong: "#2e3633"
  dark-rule: "#1f2523"
  dark-inline-code-fill: "rgba(238, 241, 239, 0.1)"
  dark-code-value: "#b4c4d8"
  dark-state-fail: "#ff8f80"
  dark-state-move: "#f0c26a"
typography:
  display:
    fontFamily: "Mona Sans, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "clamp(2.375rem, 1.3rem + 3.2vw, 3.75rem)"
    fontWeight: 700
    lineHeight: 1.03
    letterSpacing: "-0.035em"
    fontVariation: "'wdth' 96"
  headline:
    fontFamily: "Mona Sans, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "clamp(1.75rem, 1.2rem + 1.6vw, 2.5rem)"
    fontWeight: 680
    lineHeight: 1.12
    letterSpacing: "-0.03em"
    fontVariation: "'wdth' 96"
  title:
    fontFamily: "Mona Sans, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "1.375rem"
    fontWeight: 650
    lineHeight: 1.27
    letterSpacing: "-0.015em"
  subtitle:
    fontFamily: "Mona Sans, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 650
    lineHeight: 1.41
    letterSpacing: "-0.01em"
  lead:
    fontFamily: "Mona Sans, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 400
    lineHeight: 1.6
  body:
    fontFamily: "Mona Sans, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.65
  body-sm:
    fontFamily: "Mona Sans, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "Mona Sans, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.54
  control:
    fontFamily: "Mona Sans, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 600
  mono-command:
    fontFamily: "Monaspace Neon, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.71
  mono-data:
    fontFamily: "Monaspace Neon, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.85
    fontFeature: "'tnum'"
rounded:
  focus: "4px"
  control: "8px"
  block: "10px"
  panel: "14px"
spacing:
  control-gap: "0.75rem"
  panel: "1.25rem"
  gutter-narrow: "1.5rem"
  gutter: "2rem"
  tab-rail-gap: "2.5rem"
  column-gap: "4rem"
  section-narrow: "4.25rem"
  section-mid: "5rem"
  section: "6.5rem"
  page-max: "1200px"
components:
  button-primary:
    backgroundColor: "{colors.signal}"
    textColor: "{colors.on-signal}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    height: "2.75rem"
    padding: "0 1.125rem"
  button-primary-hover:
    backgroundColor: "{colors.signal-hover}"
    textColor: "{colors.on-signal}"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    height: "2.75rem"
    padding: "0 1.125rem"
  control-compact:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    height: "2.5rem"
    padding: "0 0.875rem"
  panel:
    backgroundColor: "{colors.ground-alt}"
    textColor: "{colors.ink}"
    rounded: "{rounded.panel}"
  install-row:
    backgroundColor: "{colors.ground-alt}"
    textColor: "{colors.ink}"
    typography: "{typography.mono-command}"
    rounded: "{rounded.block}"
    padding: "0.8125rem 1rem"
  code-block:
    backgroundColor: "{colors.ground-alt}"
    textColor: "{colors.ink}"
    rounded: "{rounded.block}"
  trace-row:
    textColor: "{colors.ink-dim}"
    typography: "{typography.mono-data}"
    padding: "0 1.25rem"
  trace-row-answered:
    backgroundColor: "{colors.signal-wash}"
    textColor: "{colors.ink}"
    typography: "{typography.mono-data}"
    padding: "0 1.25rem"
---

# Design System: Universal LLM Client documentation site

## Overview

**Creative North Star: "The Audit Log"**

**Scope.** This file covers the documentation site only: the homepage (`docs/index.md` and the components in `docs/.vitepress/theme/home/`) plus the tokens in `docs/.vitepress/theme/tokens.css` and the code themes in `docs/.vitepress/config.mts`, which the guide and API pages inherit. The local testing workbench described in `PRODUCT.md` is a different surface and is not covered here. Colour values in the frontmatter are light theme first; the same roles prefixed `dark-` are the dark theme.

The site is a serious library site for developers and for AI agents building tools. It states the offer in plain words and then proves it with the thing the library actually produces: a list of audit events. Everything else follows from that log. Surfaces are near-white or near-black neutrals with a faint green cast, separated by one-pixel rules. Type is one sans family for prose and one monospace family for anything a machine says. A single green appears only where something answered, where something is live, or where the primary action is.

The homepage is dense and flat. It uses tables, tabbed code and log rows as its component language, and it has no hero illustration, logo strip, icon-card grid, glass, glow or gradient. Compatibility is stated per wire protocol (OpenAI Chat Completions, Anthropic Messages, Gemini, Ollama) in a table, and code samples use placeholder model ids. Motion is limited to one authored moment, the playback of the failover trace, and that moment has a reduced-motion path.

The guide and API pages keep the default VitePress theme layout. They inherit the fonts, grounds, ink, signal green, focus ring and code themes, and nothing else. On those pages the default theme also applies the signal green to body links and to the current navigation item.

**Key Characteristics:**
- Neutral grounds with a slight green cast, in a light and a dark theme of equal standing.
- One signal green, used for what answered, what is live, and the primary action.
- Hairline panels and rules. No shadow, glass, gradient or glow anywhere.
- Mona Sans for prose, Monaspace Neon for code, commands, ids and timestamps.
- Code in neutral ink with one quiet blue for literal values and no red family.
- Drawn 16px single-stroke icons from one family.
- One authored motion moment, the trace playback, with a reduced-motion path.

## Colors

A neutral palette in two themes, one green signal, and two state colours that exist only inside the trace.

### Primary
- **Signal Green** (`signal`, `dark-signal`): the primary button fill, the indicator on the selected capability tab, the RESPONSE event and its check mark, the focus ring, and the text selection tint (30% mix over transparent). The dark theme uses a brighter mint so the same role stays legible on near-black.
- **Signal Green, pressed states** (`signal-hover`, `signal-active`, `dark-signal-hover`, `dark-signal-active`): hover and active fills of the primary button. In the light theme they darken; in the dark theme hover lightens and active darkens.
- **Signal Wash** (`signal-wash`, `dark-signal-wash`): the tint behind the row that answered in the trace, behind the answering provider's lines in the code sample beside it, and behind highlighted code lines on doc pages.
- **On Signal** (`on-signal`, `dark-on-signal`): text on the primary button. White on the light theme's deep green, near-black green on the dark theme's mint.
- **Deep Mint** (`dark-signal-deep`): the solid brand step in the dark theme, and the filled dot of the logo mark.

### Secondary
- **Value Blue** (`code-value`, `dark-code-value`): strings, numbers, language constants and escapes in code blocks. It is the only hue in code and appears nowhere else.

### Tertiary
- **Failure Red** (`state-fail`, `dark-state-fail`): the ERROR event name and its cross in the trace. Nowhere else.
- **Movement Amber** (`state-move`, `dark-state-move`): the FAILOVER event name and its arrow in the trace. Nowhere else. In the stylesheet this token is named for retry, but the build applies it to failover and renders RETRY in dim ink.

### Neutral
- **Ground** (`ground`, `dark-ground`): the page, the code half of the demo, compact controls, and tab cells on narrow screens.
- **Alternate Ground** (`ground-alt`, `dark-ground-alt`): framed panels, the install row, table heads, and code blocks. The dark theme adds two further steps, `dark-ground-soft` for soft fills and `dark-ground-raised` for default-theme popovers, and `dark-gutter` for the gap the default theme draws between layout regions.
- **Ink** (`ink`, `dark-ink`): headings, primary text, identifiers in code, and inline code.
- **Dim Ink** (`ink-dim`, `dark-ink-dim`): supporting paragraphs, term labels, keywords and punctuation in code, and unselected tabs.
- **Faint Ink** (`ink-faint`, `dark-ink-faint`): code comments, trace timestamps, the arrow icon on text links, and the border of a hovered control.
- **Strong Rule** (`rule-strong`, `dark-rule-strong`): the outline of panels and controls, and the resting underline of text links.
- **Rule** (`rule`, `dark-rule`): dividers inside panels, table row lines, and list separators.
- **Inline Code Fill** (`inline-code-fill`, `dark-inline-code-fill`): the faint neutral chip behind inline code on doc pages. Inline code is ink on this fill and never the brand colour.

The logo mark (`docs/public/logo.svg`, `docs/public/favicon.svg`) is three circles in a row: two outlined in a mid grey (`#8a918e`, 1.5px stroke) and the third filled green. The grey belongs to the mark only.

### Named Rules
**The Signal Rule.** Green marks only what answered, what is live, and the primary action. On the homepage that is the RESPONSE row and the provider lines that produced it, the selected tab, the focus ring and selection, and one filled button. Text links, secondary buttons, icons and inline code stay in neutral ink.

**The Quiet Code Rule.** Code is neutral ink in three strengths (ink for identifiers, dim ink for keywords and punctuation, faint ink for comments) plus Value Blue for literals. There is no red family in code, so a code sample can never compete with the failure state in the trace beside it.

**The Never Colour Alone Rule.** Every trace state is carried by its event name in words and by an icon, and only then by colour. ERROR has a cross, RESPONSE a check, FAILOVER an arrow, RETRY a loop.

## Typography

**Display Font:** Mona Sans, variable (weights 200 to 900, widths 75% to 125%), with ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif
**Body Font:** Mona Sans, same file and fallbacks
**Label/Mono Font:** Monaspace Neon at 400 and 600, with ui-monospace, SFMono-Regular, Menlo, Consolas, monospace

Both families are self-hosted as Latin subsets in `docs/public/fonts/`, with their licence files beside them, and load with `font-display: swap`. The default theme's own font is not loaded.

**Character:** One grotesque carries everything a person says, pulled slightly narrow and tight at heading sizes so headlines read as statements. One monospace carries everything a machine says, and it is never used for headings or labels.

### Hierarchy
- **Display** (700, `clamp(2.375rem, 1.3rem + 3.2vw, 3.75rem)`, line-height 1.03, letter-spacing -0.035em, width 96%): the homepage headline, once, balanced across lines.
- **Headline** (680, `clamp(1.75rem, 1.2rem + 1.6vw, 2.5rem)`, line-height 1.12, letter-spacing -0.03em, width 96%): section headings.
- **Title** (650, 1.375rem on a 1.75rem line, letter-spacing -0.015em): the heading inside a capability panel.
- **Subtitle** (650, 1.0625rem or 1rem on a 1.5rem line, letter-spacing -0.01em): headings inside framed panels.
- **Lead** (400, 1.125rem under the headline and 1.0625rem under section headings, line-height 1.6, dim ink): one paragraph per heading, capped at 41rem and 36rem.
- **Body** (400, 1rem at line-height 1.65, and 0.9375rem at 1.5 to 1.55): panel summaries, list rows, table cells and notes.
- **Label** (400, 0.8125rem on a 1.25rem line, dim ink): term labels, legends, the simulation notice and status text. Labels are sentence case. Nothing in the theme or the homepage is set in uppercase by style; the trace event names are uppercase because that is how the library names them.
- **Control** (600, 0.9375rem; 0.875rem in compact controls): buttons, text links and navigation rows.
- **Mono** (Monaspace Neon 400, 600 for trace event names): the install command at 0.875rem on a 1.5rem line, trace rows at 0.8125rem on a 1.5rem line with tabular figures, provider ids at 0.75rem, inline code at 0.875em. Code and trace drop to 0.75rem below 640px.

Weights in use are 400, 500 (unselected tab), 550 (data values and row heads), 600, 650, 680 and 700. On doc pages, h1 to h3 take -0.015em letter-spacing and balanced wrapping, links are underlined 3px below the baseline, and tables use tabular figures.

### Named Rules
**The Two Voices Rule.** Mona Sans is for what a person says. Monaspace Neon is for what a machine says: code, commands, provider types, ids, paths and timestamps. A value never changes family to look more technical, and a heading is never set in monospace.

**The 46 Column Rule.** Homepage code samples are wrapped to 46 columns or fewer, so that at 0.75rem with 16px side padding they fit a phone without horizontal scrolling. Code containers go edge to edge below 640px for the same reason.

## Layout

The homepage is a single column of sections inside a 1200px page (`page-max`) with 2rem gutters, 1.5rem below 640px. It sets `layout: home` with markdown styles off, so the page owns its own rhythm. Sections are left aligned. Nothing is centred.

- **Grid.** Two-column blocks split 7 to 5 (offer and action, facts and machine panel) or 5 to 7 (closing install and links) with a 4rem column gap. The offer row aligns its columns to the bottom edge. The failover panel is two equal halves. The capability block is an 11rem tab rail plus a panel split 9 to 14, with 2.5rem gaps.
- **Vertical rhythm.** Sections sit 6.5rem apart, 5rem below 960px and 4.25rem below 640px. A section heading block is at most 44rem wide and sits 2.75rem above its content, 2rem below 640px. The closing section is preceded by a one-pixel rule with 4.5rem below it.
- **Density.** Panel sections pad 1.25rem horizontally, 1rem below 640px. Table cells pad 0.8125rem by 1.25rem. Separated list rows pad 0.625rem to 0.9375rem vertically. Controls sit 0.75rem apart.
- **Breakpoints.** At 1100px the capability panel stacks its text over its code. At 960px the two-column blocks and the failover panel stack. At 860px the tab rail becomes a grid of cells above the panel. At 640px gutters narrow, code and the failover panel go edge to edge, the protocol table switches to short column heads with a sticky first column, and the provider selects stack as label and control rows. At 480px the install command shrinks to 0.75rem and its copy button becomes icon only with a hidden text label. With a coarse pointer the package manager pills grow their padding.
- **First viewport.** At 1440 by 900 the headline, the offer paragraph, the install command, both buttons, the three facts and the top of the failover panel, including the answered row, are all above the fold.

### Named Rules
**The Reserved Height Rule.** Anything that changes while the visitor watches keeps its height. The trace has a reserved height and scrolls inside itself, a new run replaces rows in place, and the status sentence and the copy confirmation hold a minimum height when empty. The page never jumps.

## Elevation & Depth

The system is flat. There is no elevation shadow, no blur, no gradient and no glow in the theme or the homepage. Depth comes from two things only: a one-pixel outline in Strong Rule, and a single tonal step from Ground to Alternate Ground. Inside a panel, regions are divided by one-pixel lines in Rule.

`box-shadow` appears twice in the build and both times as an inset line, not as elevation: a one-pixel inset ring on the selected package manager pill, and a 2px inset bottom line in Signal Green on the selected tab cell at narrow widths.

### Named Rules
**The Hairline Rule.** A surface is separated from the page by one pixel of rule and at most one tonal step. If a panel seems to need a shadow to read as a panel, its outline or its ground is wrong.

## Shapes

Corners are gently rounded and step down with size: framed panels at 14px, code blocks and the install row at 10px (`--ulc-radius`), buttons, selects and compact controls at 8px, and the focus ring at 4px. Every outline is one pixel. Panels clip their contents, so internal dividers run to the edge. Below 640px the failover panel and code blocks lose their side borders and radius and run edge to edge.

Lists are drawn as rows between hairlines, not as bullets or tiles. Icons are a single family drawn in `docs/.vitepress/theme/home/UlcIcon.vue`: a 16px grid, a 1.5px stroke with round caps and joins, no fill, coloured by the surrounding text. The set is copy, check, cross, arrow, retry and chevron.

## Components

### Buttons
- **Shape:** gently rounded (8px), 2.75rem tall, 1.125rem side padding, weight 600 at 0.9375rem, with an optional trailing arrow icon 0.5rem away.
- **Primary:** Signal Green fill with On Signal text and a border of the same green. One per view.
- **Secondary:** transparent with a Strong Rule outline and Ink text.
- **Hover / Focus:** the primary darkens to its hover step; the secondary's outline moves to Faint Ink; a trailing arrow slides 3px right over 0.25s. Colour changes take 0.2s on `cubic-bezier(0.16, 1, 0.3, 1)`. Focus is a 2px Signal Green outline, 2px off the element, on every focusable element site wide.
- **Compact control:** 2.5rem tall on Ground with a Strong Rule outline, used for Run again and the provider selects.

### Chips
- **Style:** the package manager switch is a row of radio inputs drawn as small pills in Monaspace Neon at 0.8125rem, dim ink, no fill.
- **State:** the selected pill takes Ink, a soft ground fill and a one-pixel inset ring. Hover moves the text to Ink. Focus draws the standard ring around the pill.

### Cards / Containers
- **Corner Style:** 14px for framed panels, 10px for code blocks and the install row.
- **Background:** Alternate Ground, with Ground for the code half of the failover panel.
- **Shadow Strategy:** none. See Elevation & Depth.
- **Border:** one pixel of Strong Rule outside, one pixel of Rule between regions.
- **Internal Padding:** 1.25rem, or 1.5rem for a panel that holds prose.

Panels frame things that work: the failover demo, the protocol table and the plain-text documentation links for agents. Prose and fact lists sit directly on the page between hairlines.

### Inputs / Fields
- **Style:** the provider select is a native select with its appearance removed: 2.5rem tall, 8px corners, Ground fill, Strong Rule outline, 0.875rem text, and a drawn chevron in dim ink at the right. Its label sits above it with the provider id beside it in monospace.
- **Focus:** the standard 2px Signal Green ring. Hover moves the outline to Faint Ink.

### Navigation
- **Site chrome:** the default VitePress navigation bar, sidebar, outline and local search, recoloured by the tokens. The title is tracked at -0.01em and sits beside the three-circle mark.
- **Capability tabs:** a vertical rail on a hairline. The selected tab takes Ink at weight 650 and a one-pixel Signal Green segment on the rail; the rest are dim ink at weight 500. Below 860px the rail becomes a hairline grid of cells at least 2.75rem tall, three across on a phone, with a 2px green bottom line on the selected cell. Arrow keys, Home and End move between tabs. Without JavaScript every panel is shown and the tabs are hidden.
- **Text links:** Ink at weight 600, underlined 5px below the baseline in Strong Rule, with the underline taking the text colour on hover and a faint-ink arrow that slides 3px.
- **Closing links:** a two-column list of rows between hairlines, each a label with a trailing arrow at the far edge.

### Install Command
A two-part row at 10px corners on Alternate Ground: the command in Monaspace Neon, then a Copy button divided off by a one-pixel rule. Pressing Copy swaps the icon to a check and the label to Copied for 2.4 seconds, and a status line below says what happened, including when the browser blocks the copy. The row is capped at 30rem and appears at the top and at the close of the page.

### Failover Trace
The signature component, in `docs/.vitepress/theme/home/FailoverDemo.vue`. One framed panel holds a head (title on the left, the simulation notice on the right), the provider chain as code on the left, and on the right three provider selects, a status sentence with Run again, and the audit trace.

- **Rows:** Monaspace Neon at 0.8125rem on a 1.5rem line with tabular figures, in four columns: elapsed time right aligned in Faint Ink, an icon plus the event name at weight 600, the provider, and the detail. Below 640px the detail drops to its own line.
- **States:** REQUEST in Ink with no icon. RETRY in dim ink. ERROR in Failure Red. FAILOVER in Movement Amber. RESPONSE in Signal Green on a Signal Wash row with its text raised to Ink. The provider lines that produced the answer take the same wash in the code sample, so the eye connects the log to the configuration.
- **Motion:** the page loads with the finished trace and stays still. A run plays only when the visitor changes a provider or presses Run again. Rows then arrive one at a time, held 220 to 900ms apart, each fading in over 0.45s while rising 0.25rem, and the previous run's rows stay in place in dim ink at regular weight until replaced. The code highlight cross-fades over 0.5s. With reduced motion the new trace appears complete at once with no animation.
- **Announcement:** the status sentence is a polite live region, and stale rows are hidden from assistive technology.

### Protocol Table
A framed table with a tinted head row, one column per wire protocol, a first body row listing the provider `type` values in monospace, and one row per capability. Supported is a drawn check with a hidden text equivalent. Unsupported is the words "Not supported" in dim ink. A caveat is written out in Ink. The table scrolls inside its frame and is focusable; below 640px it fits four columns on a phone with short heads.

### Code Blocks
Two Shiki themes built from the same tokens, `ulc-light` on Alternate Ground and `ulc-dark` on its dark counterpart, apply to every code block on the site. On the homepage a block takes a one-pixel Rule outline at 10px corners, or sits flush inside the failover panel.

### Named Rules
**The Honest Simulation Rule.** The failover demo follows the library's real routing rules and defaults: two retries on a 5xx before failing over, immediate failover with a 30 second cooldown on a 429 or a timeout, and a 2.5 second probe for a cold provider. The panel says in its head that it is simulated in the browser and that nothing is sent. If the router changes, the demo changes with it.

**The Protocol Table Rule.** Compatibility is shown as a table of wire protocols against capabilities. It is never a list, strip or grid of provider names, logos or model names, and samples use placeholder model ids.

**The One Moment Rule.** The trace playback is the only authored motion. Everything else is state feedback: 0.2s colour changes and a 3px arrow nudge on hover, all on one easing curve. Nothing animates on load or on scroll.

## Do's and Don'ts

### Do:
- **Do** keep green for what answered, what is live, and the primary action. One filled green button per view.
- **Do** separate surfaces with a one-pixel rule and at most one tonal step, at 14px corners for panels, 10px for code and 8px for controls.
- **Do** set anything a machine says in Monaspace Neon and everything else in Mona Sans.
- **Do** pair every state colour with a word and an icon.
- **Do** wrap homepage code samples to 46 columns and use placeholder model ids such as `model-id`.
- **Do** state compatibility per wire protocol, in the table.
- **Do** reserve the height of anything that updates in place, and give every motion a reduced-motion path.
- **Do** draw new icons in the existing family: 16px grid, 1.5px round stroke, no fill, current colour.
- **Do** keep both themes at 4.5:1 or better for text, including text on the green wash, where timestamps step up from Faint Ink to Dim Ink.

### Don't:
- **Don't** add elevation shadows, glass, blur, gradients or glow. An inset one-pixel line drawn with `box-shadow` is a hairline, not a shadow, and is the only permitted use.
- **Don't** use red, or any warm hue, in code themes. Red and amber belong to the trace.
- **Don't** colour text links, secondary buttons, icons or inline code green on the homepage.
- **Don't** list providers or models as proof of compatibility, and don't put real model names in samples.
- **Don't** animate on load or on scroll, and don't add a second authored motion moment.
- **Don't** use icon tiles, card grids, logo strips or a hero illustration.
- **Don't** let the demo show a sequence the router would not produce, or drop the notice that it is a simulation.
