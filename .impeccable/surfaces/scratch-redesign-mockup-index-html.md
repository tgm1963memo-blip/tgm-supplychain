---
version: 1
slug: "scratch-redesign-mockup-index-html"
primary_target: ".scratch/redesign-mockup/index.html"
related_targets: ["index.html"]
---

## Scope
Full-app redesign mockup of TSS Supply Chain: one clickable single-file prototype covering every page and sub-screen of both apps (Sales / Planning) plus admin, with synthetic data. Visitor mode: Operate. Desktop first; every page usable at 390px. Build path: code-led. Not yet applied to the production index.html.

## Audience and task
Executives, sales, planning/production and admin staff at TSS/TGM reading sales figures, filling documents and acting on approvals. Success: the figure a person came for is the clearest thing on screen, and approval status is always visible.

## Direction contract
THESIS: Every key figure is printed like the cold-chain carton label that leaves the TSS plant: a fact with a code, a lot and a date. The page refuses the generic SaaS card grid with coloured borders and emoji.
OWN-WORLD: White label stock on a cool navy-tinted ground (#F3F4F8). Logo navy #1B2064 owns the sidebar, headings and figures; logo red #C3161B is rare (one band, the current-month tick, targets, one primary action). Die-cut notched corners, a dashed perforation rule, IBM Plex Mono lot lines, a 12-tick month ruler. IBM Plex Sans Thai for the UI, tabular numerals. State marks: hollow = pending, filled = done, struck = cancelled; retired rows print grey.
STORY: The user sees the headline figures as labels, reads trend and mix below, drills into tables and documents, and acts on approvals from the same system on every page.
FIRST VIEWPORT: 232px navy sidebar with grouped menu and SVG icons; 60px white top bar (title, sync, inbox, sample-data pill); a filter row (company and period segments, chips, Export); four lot-label KPI cards; monthly bar chart (2/3) with a red dashed target beside the channel list (1/3); Top customers table below.
FORM: Lot Label (cold-chain carton label), candidate 5 of 7 grounded; seed:7e44a43b12085374. Raises: fixed columns, values change in place (split-flap); one printed state-mark vocabulary (centre rail); retired items grey (character catalog). Signature interaction: on a period switch, the label figures and ruler ticks reprint in place, with a short print-head wipe on the band.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Unresolved
Migration of this system into index.html happens in a later round after mockup approval.
