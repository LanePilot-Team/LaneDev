# Road Merge Follow-up Implementation Plan

> Execute in order with red-green-refactor tests. Preserve the dirty local road database until Commit 2 deliberately replaces it from the pinned `origin/anna` source.

## Commit 1 — preserve context and verify undo rendering

1. Add failing unit tests for serializing/restoring camera, mode, and road identity, including a missing-road fallback.
2. Add failing rendering tests for new-v2 undo and upgraded-legacy undo restoring two source segments and an unmerged median seam.
3. Implement a one-shot road-merge reload snapshot helper and integrate it before reload and after map data loading.
4. Run focused tests, all road-merge tests, and `npm.cmd run build`.
5. Amend the already committed specification/plan commit so the final first commit contains docs, tests, and implementation together.

## Commit 2 — migrate latest anna data and generate review report

1. Add failing recovery tests for `upgraded` versus `rolled_back`, tombstone-only rollback, source metadata, and idempotence.
2. Extend recovery report and CLI to accept a pinned source commit and to apply both safe upgrades and explicit rollbacks.
3. Replace the working database from `origin/anna@7d2121d`, not from the current dirty test file.
4. Run the migration once, generate the formal report, and verify 43 upgraded / 5 rolled back / 48 total.
5. Rerun migration against its output and assert byte-equivalent journal semantics with zero duplicate migration records.
6. Run merge, orphan, severed-route, merged-render, and build checks; commit tool, report, and formal migrated database only.

## Commit 3 — preserve directed snap state in routing

1. Add failing graph tests showing opposite-side clicks currently choose the same direction, a short route detours, and a side road crosses the continuous median at a merged junction.
2. Extend the snap/route endpoint representation with the selected directed edge.
3. Connect temporary endpoint nodes only to legal endpoints for that edge while retaining one-way and merged-junction same-side transition restrictions.
4. Run focused graph tests, the complete test suite, audits, and build.
5. Commit only navigation implementation and tests.

## Final verification

Inspect `git show --stat` for all three commits, confirm no local acceptance-test events remain, compare the migration input hash with `origin/anna`, then push the feature branch and start the local acceptance server only when requested.
