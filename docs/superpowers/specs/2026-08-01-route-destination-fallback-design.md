# Route Destination Direction Fallback Design

**Date:** 2026-08-01
**Status:** User approved
**Implementation branch:** `codex/road-merge-safety-implementation`

## Problem

The router projects both endpoints onto one directed lane. If the clicked destination direction is unreachable, A* receives no acceptable alternate destination even when the same undivided two-way road is reachable from its opposite direction. It therefore reports failure instead of returning the legal detour.

## Design

- Keep the start projection strict so navigation begins in the lane direction selected by the click.
- Try the clicked destination direction first.
- Only if that search is unreachable, try the twin direction of the same two-way road.
- Permit fallback only when the road has no physical centre divider (`centerM <= 0`) and carries no road-merge barrier. One-way roads, divided roads, and merged main roads retain strict destination-side selection.
- Keep road-merge barriers, one-side-entry restrictions, and U-turn restrictions unchanged. Fallback changes the acceptable arrival direction; it never adds a graph transition.

## Acceptance criteria

- A legal longer route to the opposite direction of an undivided two-way destination is returned when the clicked direction is unreachable.
- A reachable clicked direction remains preferred over the fallback.
- Starts remain direction-specific.
- One-way and physically divided destinations do not fall back across direction.
- Existing road-merge barrier tests, complete tests, audits, and build pass.
