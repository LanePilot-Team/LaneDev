
# Navigation HUD Voice Guidance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Traditional Chinese Web Speech API announcements to the existing LaneDev HUD for simulation and GPS navigation while keeping spoken wording derived from the same guidance source as the visual HUD.

**Architecture:** Extract the existing HUD thresholds, distance formatting, and maneuver wording into <code>src/nav/speechGuidance.ts</code>. Add a <code>useSpeechGuidance</code> hook that observes <code>DriveState</code>, announces start/far/near/now/arrival events once per maneuver stage, and safely no-ops when browser speech synthesis is unavailable. Wire the hook into <code>DriveHUD</code> so both driving modes use the same path.

**Tech Stack:** React 19, TypeScript, Vite 8, browser Web Speech API (<code>window.speechSynthesis</code>), and Node's built-in test runner with TypeScript imports already used by this repository.

## Global Constraints

- Base all work on <code>origin/main</code> commit <code>e6cfb56</code> in branch <code>codex/navigation-voice-guidance</code>.
- Preserve the dirty original <code>main</code> worktree; do not pull, reset, stash, or clean it.
- Use no prerecorded audio assets, third-party TTS service, API key, backend, or speech-recognition API.
- Reuse the existing HUD thresholds: 250m far, 60m near, and 25m now.
- Keep visual HUD wording unchanged except for moving shared helpers to a focused module.
- Set <code>SpeechSynthesisUtterance.lang</code> to <code>zh-TW</code>, prefer an installed Traditional Chinese voice, and silently disable speech when synthesis is unavailable.
- New threshold announcements cancel an unfinished older utterance so the latest navigation instruction wins.
- Commit completed tasks with Chinese commit messages; do not push, create a PR, or merge <code>main</code>.

---

## File Map

| File | Responsibility |
|---|---|
| <code>src/nav/speechGuidance.ts</code> | Shared phase, distance, existing HUD wording, maneuver verbs, speech stage/key, and pure sentence composition. |
| <code>src/nav/speechGuidance.test.mjs</code> | Boundary and wording tests for the pure helpers. |
| <code>src/nav/useSpeechGuidance.ts</code> | Browser speech side effect, event detection, deduplication, voice selection, and cleanup. |
| <code>src/nav/DriveHUD.tsx</code> | Uses shared helpers and invokes the hook without changing the rendered layout. |
| <code>src/plan/ManeuverList.tsx</code> | Imports <code>guidanceText</code> from the shared helper module. |
| <code>package.json</code> | Adds the focused test script and includes it in <code>test:all</code>. |

## Task 1: Extract and test shared guidance and speech wording

**Files:**
- Create: <code>src/nav/speechGuidance.ts</code>
- Create: <code>src/nav/speechGuidance.test.mjs</code>
- Modify: <code>src/nav/DriveHUD.tsx</code>
- Modify: <code>src/plan/ManeuverList.tsx</code>
- Modify: <code>package.json</code>

**Interfaces:**
- Consumes: <code>Maneuver</code> and <code>Profile</code> from <code>src/core/graph.ts</code>.
- Produces: <code>Phase</code>, three threshold constants, distance helpers, <code>guidanceText</code>, <code>THEN_VERB</code>, <code>SpeechStage</code>, <code>speechStage</code>, <code>maneuverSpeechKey</code>, and <code>buildSpeechAnnouncement</code>.

- [ ] **Step 1: Write the failing pure-helper tests**

Create <code>src/nav/speechGuidance.test.mjs</code>. It must import <code>./speechGuidance.ts</code> like the existing lane-preview tests and cover:

    import test from 'node:test'
    import assert from 'node:assert/strict'
    import {
      buildSpeechAnnouncement,
      formatDistanceText,
      getGuidancePhase,
      speechStage,
    } from './speechGuidance.ts'

    const maneuver = (overrides = {}) => ({
      distM: 250,
      kind: 'right',
      lanesForward: 3,
      ...overrides,
    })

    test('keeps exact HUD phase boundaries', () => {
      assert.equal(getGuidancePhase(251), 'ahead')
      assert.equal(getGuidancePhase(250), 'far')
      assert.equal(getGuidancePhase(60), 'near')
      assert.equal(getGuidancePhase(25), 'near')
      assert.equal(formatDistanceText(25), '前方 30 公尺')
      assert.equal(formatDistanceText(1000), '前方 1.0 公里')
    })

    test('emits threshold stages only at or below 250m', () => {
      assert.equal(speechStage(251), null)
      assert.equal(speechStage(250), 'far')
      assert.equal(speechStage(60), 'near')
      assert.equal(speechStage(25), 'now')
    })

    test('builds far lane preparation wording', () => {
      assert.equal(buildSpeechAnnouncement({
        distanceM: 250,
        maneuver: maneuver(),
        profile: 'car',
        twoStage: false,
        stage: 'far',
      }), '前方 250 公尺後前往右側車道，準備右轉，請提早變換車道')
    })

    test('builds near and now two-stage wording', () => {
      const m = maneuver({ kind: 'left', twoStage: true })
      assert.match(buildSpeechAnnouncement({
        distanceM: 60, maneuver: m, profile: 'moto', twoStage: true, stage: 'near',
      }), /^前方 60 公尺靠右進入待轉區/)
      assert.match(buildSpeechAnnouncement({
        distanceM: 25, maneuver: m, profile: 'moto', twoStage: true, stage: 'now',
      }), /^現在靠右進入待轉區/)
    })

    test('keeps road name and a close subsequent maneuver', () => {
      const text = buildSpeechAnnouncement({
        distanceM: 55,
        maneuver: maneuver({ roadName: '德民路' }),
        next2: maneuver({ distM: 300, kind: 'left' }),
        profile: 'car',
        twoStage: false,
        stage: 'near',
      })
      assert.match(text, /進入德民路/)
      assert.match(text, /隨後左轉/)
    })

    test('uses arrival wording without lane preparation', () => {
      assert.equal(buildSpeechAnnouncement({
        distanceM: 250,
        maneuver: maneuver({ kind: 'arrive' }),
        profile: 'car',
        twoStage: false,
        stage: 'far',
      }), '前方 250 公尺後即將抵達目的地')
    })

- [ ] **Step 2: Run the focused test and verify failure**

Run from the worktree root:

    npm run test:speech-guidance

Expected: failure because the new module and package script do not exist.

- [ ] **Step 3: Create the shared helper module**

Create <code>src/nav/speechGuidance.ts</code> with these public declarations:

    export const FAR_THRESHOLD = 250
    export const NEAR_THRESHOLD = 60
    export const PASS_THRESHOLD = 25
    export type Phase = 'ahead' | 'far' | 'near'
    export type SpeechStage = 'far' | 'near' | 'now'

    export function getGuidancePhase(distanceM: number): Phase {
      return distanceM < NEAR_THRESHOLD ? 'near'
        : distanceM < FAR_THRESHOLD ? 'far' : 'ahead'
    }

    export function speechStage(distanceM: number): SpeechStage | null {
      if (!Number.isFinite(distanceM) || distanceM > FAR_THRESHOLD) return null
      if (distanceM <= PASS_THRESHOLD) return 'now'
      if (distanceM <= NEAR_THRESHOLD) return 'near'
      return 'far'
    }

    export function roundDistance(m: number): string {
      if (m < 100) return String(Math.round(m / 10) * 10)
      return String(Math.round(m / 50) * 50)
    }

    export function formatDistanceText(m: number): string {
      return m > 1000 ? '前方 ' + (m / 1000).toFixed(1) + ' 公里'
        : '前方 ' + roundDistance(m) + ' 公尺'
    }

Move the existing <code>guidanceText</code> implementation from <code>DriveHUD.tsx</code> unchanged into this file. Also move <code>THEN_VERB</code> here as an exported record for <code>left</code>, <code>right</code>, <code>uturn</code>, <code>slight-left</code>, and <code>slight-right</code>.

Add the pure speech helpers:

    export function maneuverSpeechKey(m: Maneuver): string {
      return String(m.nodeId ?? ('d' + m.distM)) + ':' + m.kind
    }

    export function buildSpeechAnnouncement(args: {
      distanceM: number
      maneuver: Maneuver
      next2?: Maneuver | null
      profile: Profile
      twoStage: boolean
      stage: SpeechStage
    }): string {
      const { distanceM, maneuver, next2, profile, twoStage, stage } = args
      const phase: Phase = stage === 'far' ? 'far' : 'near'
      const bay = !twoStage && maneuver.bayOffM !== undefined
      const guidance = guidanceText(maneuver, phase, profile, twoStage, bay)
        .replaceAll('・', '，')
      const distance = stage === 'now' ? '現在' : formatDistanceText(distanceM)
      const after = stage === 'far' ? '後' : ''
      const preparation = stage === 'far' && maneuver.kind !== 'arrive'
        ? twoStage ? '，請提早靠右進入待轉區' : '，請提早變換車道'
        : ''
      const subsequent = stage === 'near' && next2
        && next2.kind !== 'arrive' && next2.distM - maneuver.distM < 60
        ? '，隨後' + THEN_VERB[next2.kind]
        : ''
      return distance + after + guidance + preparation + subsequent
    }

- [ ] **Step 4: Switch existing consumers to the shared module**

In <code>src/nav/DriveHUD.tsx</code>, import the threshold constants, distance helpers, <code>getGuidancePhase</code>, and <code>guidanceText</code> from <code>./speechGuidance</code>. Remove only the duplicated constants, phase type, rounding helper, guidance function, and <code>THEN_VERB</code>. Keep visual components and layout unchanged. Replace local calculations with:

    const phase = getGuidancePhase(dist)
    const distText = dist < PASS_THRESHOLD ? '現在' : formatDistanceText(dist)

In <code>src/plan/ManeuverList.tsx</code>, import <code>guidanceText</code> from <code>../nav/speechGuidance</code> and keep <code>ManeuverArrow</code> imported from <code>../nav/DriveHUD</code>.

- [ ] **Step 5: Add the focused script and run tests**

Add this package script and prefix it into <code>test:all</code>:

    "test:speech-guidance": "node --test src/nav/speechGuidance.test.mjs"

Run:

    npm run test:speech-guidance

Expected: all pure-helper tests pass.

- [ ] **Step 6: Commit Task 1**

    git add src/nav/speechGuidance.ts src/nav/speechGuidance.test.mjs src/nav/DriveHUD.tsx src/plan/ManeuverList.tsx package.json
    git commit -m "抽離導航語音共用文案與距離階段"

## Task 2: Implement the Web Speech API hook

**Files:**
- Create: <code>src/nav/useSpeechGuidance.ts</code>

**Interfaces:**
- Consumes: <code>DriveState</code>, <code>Profile</code>, and Task 1 helpers.
- Produces: <code>useSpeechGuidance({ drive, profile, twoStage }): void</code>.

- [ ] **Step 1: Define the hook contract**

Create:

    import { useEffect, useRef } from 'react'
    import type { Profile } from '../core/graph'
    import type { DriveState } from './drive'

    export interface UseSpeechGuidanceArgs {
      drive: DriveState | null
      profile: Profile
      twoStage: boolean
    }

    export function useSpeechGuidance(args: UseSpeechGuidanceArgs): void {
      void args
    }

- [ ] **Step 2: Implement local Web Speech playback**

Implement a local <code>speak(text: string): void</code> that returns when <code>window</code> or <code>window.speechSynthesis</code> is unavailable. Otherwise create <code>SpeechSynthesisUtterance</code>, set language <code>zh-TW</code>, rate <code>0.95</code>, and volume <code>1</code>. Choose an exact <code>zh-TW</code> voice first, then any <code>zh</code> voice. Call <code>synth.cancel()</code> before <code>synth.speak(utterance)</code>.

- [ ] **Step 3: Implement progress reset and deduplication**

Maintain:

    const spokenKeysRef = useRef(new Set<string>())
    const sessionStartedRef = useRef(false)
    const previousProgressRef = useRef<number | null>(null)

In the drive effect, clear all refs when <code>drive === null</code>. If the new <code>drive.traveledM</code> is at least 5m behind the previous value, clear the set and start a new speech session; this covers replay and reroute without adding speech state to <code>useDrive</code>. Use <code>speechStage(drive.nextDistM)</code> only when <code>drive.next</code> is non-null. Use <code>arrival</code> as the arrival key.

- [ ] **Step 4: Implement start, threshold, and arrival events**

The dependency-driven effect must:

1. Reset on a null drive or a backward progress jump.
2. Speak <code>開始導航</code> once for a new session; if the first valid state is already within 250m, combine it with the first instruction so it is not immediately cancelled by the threshold announcement.
3. Speak <code>已抵達目的地</code> once when <code>drive.arrived</code> first becomes true.
4. For each non-arrival maneuver, compute <code>stage = speechStage(drive.nextDistM)</code>, create a key from <code>maneuverSpeechKey(drive.next)</code> plus stage, skip existing keys, compose with <code>buildSpeechAnnouncement</code>, record the key, and speak it.
5. Add a dedicated <code>start</code> key when the combined start/instruction sentence is used.

Every access to <code>drive.next</code> fields must be guarded. Do not leave helper names undefined; define concrete local functions for clearing refs, resetting backward progress, recording keys, and speaking once.

- [ ] **Step 5: Add unmount cleanup**

Add a mount-only effect that calls <code>window.speechSynthesis.cancel()</code> when available. Do not put cancellation in the drive effect cleanup, because HUD ticks occur every 160ms.

- [ ] **Step 6: Build and commit Task 2**

    npm run build
    git add src/nav/useSpeechGuidance.ts
    git commit -m "新增導航 HUD Web Speech 語音 hook"

Expected: build passes and the commit contains only the new hook.

## Task 3: Wire the hook into HUD and complete verification

**Files:**
- Modify: <code>src/nav/DriveHUD.tsx</code>

**Interfaces:**
- Consumes: <code>useSpeechGuidance</code> from Task 2.
- Produces: spoken guidance for simulation and GPS without changing <code>useDrive</code> signatures.

- [ ] **Step 1: Call the hook from the shared HUD entry point**

Import:

    import { useSpeechGuidance } from './useSpeechGuidance'

At the top of <code>DriveHUD</code>, before the <code>if (!drive)</code> transition render, call:

    useSpeechGuidance({ drive, profile, twoStage })

Do not add speech callbacks to <code>useDrive</code>, <code>Driver</code>, or <code>GpsDriver</code>.

- [ ] **Step 2: Run focused tests and production build**

    npm run test:speech-guidance
    npm run build

Expected: focused tests pass and TypeScript/Vite build passes.

- [ ] **Step 3: Run the complete test suite**

    npm run test:all

Expected: all existing lane-preview, lane-guidance, merge, editor, segment, stack, time, road-save, and road-merge tests pass, including <code>test:speech-guidance</code>.

- [ ] **Step 4: Perform browser verification**

Run:

    npm run dev

Verify:

1. Demo simulation speaks only after navigation begins.
2. Far, near, and now events occur once per maneuver.
3. Right-turn speech includes the same lane-preparation wording as the HUD.
4. Motorcycle two-stage left turn says to move right into the waiting area.
5. Arrival speaks <code>已抵達目的地</code> once.
6. Ending navigation cancels stale speech; a new route starts a new session.
7. GPS navigation uses the same announcements.
8. A browser without <code>speechSynthesis</code> keeps HUD/navigation usable with no uncaught exception.

- [ ] **Step 5: Verify final scope and original main**

In the feature worktree:

    git diff --check
    git status --short --branch
    git log --oneline --decorate -6

In the original checkout:

    git status --short --branch

Expected: the feature worktree has only design, plan, and implementation commits; the original dirty <code>main</code> retains its pre-existing lockfile changes and untracked folder with no new changes.

- [ ] **Step 6: Commit the HUD integration**

    git add src/nav/DriveHUD.tsx
    git commit -m "接入導航 HUD 語音指引"

Do not push, open a PR, or merge <code>main</code>.

## Plan Self-Review

- **Spec coverage:** Web Speech API/no audio assets, shared HUD wording, 250/60/25m thresholds, simulation/GPS parity, browser fallback, cleanup, tests, build, and manual acceptance all have explicit task steps.
- **Placeholder scan:** No incomplete instruction or unspecified validation remains. Task 2 Step 4 requires every named local helper to be concretely implemented before the build.
- **Type consistency:** Task 1 exports the helpers imported by Task 2; Task 2 exports the exact hook shape used by Task 3; every <code>drive.next</code> access is guarded.
- **Scope check:** The plan changes only shared guidance composition, browser speech side effects, HUD wiring, and tests/scripts; it does not change routing, lane legality, GPS projection, data, or visual layout.
