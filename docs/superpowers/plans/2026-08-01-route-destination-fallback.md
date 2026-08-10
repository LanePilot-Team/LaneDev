# Route Destination Direction Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Return a legal detour through the opposite arrival direction of an undivided two-way destination when the clicked direction is unreachable.

**Architecture:** Preserve one strict start projection. Produce ordered destination projections from the clicked direction and its twin, then run the existing route search for each eligible destination in order. Exclude the twin fallback for one-way and physically divided roads.

**Tech Stack:** TypeScript, GeoJSON road graph, Node test runner, Vite.

## Global Constraints

- Do not alter road-merge barriers, one-side-entry rules, or U-turn legality.
- Do not stage or commit `public/data/road_database.json`.
- Commit messages are primarily Chinese.

---

### Task 1: Directed destination fallback

**Files:**
- Modify: `src/core/graph.ts`
- Test: `src/core/graphRouteState.test.mjs`

**Interfaces:**
- Consumes: `RoadGraph.route(fromP, toP, profile)` and directed twin edges.
- Produces: ordered goal-direction fallback without changing the public route API.

- [x] **Step 1: Write the failing legal-detour test**

Create a graph where the clicked forward goal can only U-turn at a merge barrier, while the reverse goal is legally reachable through a detour. Assert that `route()` returns the detour and its final span is backward.

- [x] **Step 2: Run the focused test and verify RED**

Run: `node --test src/core/graphRouteState.test.mjs`
Expected: the new legal-detour assertion fails because `route()` returns `null`.

- [x] **Step 3: Implement ordered destination projections**

Refactor the current projection helper to return legal candidates ordered by click distance. Keep the first candidate for starts. In `route()`, run the existing search for the primary goal, then its twin only when `oneway === 'no'` and `centerM <= 0`.

- [x] **Step 4: Add divided-road and primary-preference regressions**

Assert that a divided target remains unreachable through the opposite side and that an already reachable clicked direction does not use fallback.

- [x] **Step 5: Verify and publish**

Run the focused graph tests, `npm.cmd run test:all`, routing/render audits, and `npm.cmd run build`. Stage only the specification, plan, graph implementation, and tests; commit with a Chinese message and push the feature branch.
