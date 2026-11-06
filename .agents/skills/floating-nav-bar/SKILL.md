---
name: floating-nav-bar
description: How to build Collin's style of floating nav bar and index router — one pill-shaped glass bar, snap/lock or free drag, rows, collapse stages, and a personal style editor. Use when asked to build, change or explain this nav bar concept.
---

# Floating nav bar — the concept

One bar for the whole app. It belongs to the person, not the page.

## Core shape
- A single glass pill, fixed on screen. Left side: a tiny control strip (back, lock/snap, grip, orientation, rows, collapse, edit). Right side: pinned page buttons, widgets, Create, SANDi index router.
- Three collapse stages, cycled by one button: full labels → icons only → control strip only.
- Horizontal or vertical. 1–10 rows, buttons balanced evenly, never an empty row.

## Snap vs free (both, never one)
- New users start **snapped**: the bar rests bottom-centre and cannot be dragged, so nothing blocks the first visit.
- A lock button on the control strip toggles snap. Unsnapped: press and hold anywhere on the bar, then drag it anywhere. Position is clamped on screen, survives resize, and a drop never fires a click.

## Personal style ("Paint for the nav bar")
- Editor holds: pinned pages, widgets, rows, label size, icon size (the control strip scales with it), highlight colour, animated theme (plain, neon, pulse, aurora, disco).
- Colours come only from theme tokens, scoped to the bar — the app's own colours are never changed.
- Animations respect reduced-motion.

## Index router (SANDi)
- Every app listed once, with short, readable abbreviations and unique initials.

## Rules
- Saved per account, never shared between people on one machine.
- Nothing pops up unasked; tap targets stay easy to hit.
- Keep the original look: the glass pill is the identity, themes decorate it, never replace it.
