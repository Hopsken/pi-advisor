// Branch alignment via entry-id longest-common-prefix. PLAN §5, issue #03.
//
// The advisor accumulates context by consuming a sequence of main-branch
// `SessionEntry.id`s (`fedEntryIds`, stored in `AdvisorController` state).
// After every observe / `session_tree` / `session_compact`, the controller
// compares that stored sequence against the current branch's entry ids
// (`curIds = getBranch().map(e => e.id)`) using `planAlignment` and decides:
//
//   - **advance** — `fed` is a strict prefix of `cur`; compress `cur[k:]` and
//     append to the advisor's resident session (cache stays hot).
//   - **noop** — the sequences match exactly; nothing to feed.
//   - **divergence** — `fed` is *not* a prefix of `cur` (the current branch
//     forked away, was rewound to a prefix, or got compacted). The advisor's
//     trailing context `[k:]` belongs to an abandoned path; recover via "档 A":
//     dispose the advisor session, mint a new sessionId, and replay the full
//     current branch as a compressed snapshot (cache goes cold once).
//
// Robustness hinge: this is pure id comparison, independent of event delivery.
// Even if a `session_tree` / `session_compact` event is missed, the next
// `turn_end` observe recomputes the LCP and discovers `k < fed.length` on its
// own, triggering reset. Events only buy promptness (aborting in-flight review
// via epoch bump); alignment correctness does not depend on them.
//
// Lifecycle note (PLAN §5): `/fork`, `/new`, `/resume` rebuild the extension
// instance, so a fresh instance always starts with `fed = []` and the first
// observe reduces to `advance` with `newIds = cur` — the cold-start / post-fork
// / late-enable paths are all the same case here. `longestCommonPrefixLen` and
// `planAlignment` are pure functions with no imports beyond local types.

/**
 * Outcome of {@link planAlignment}. Each variant corresponds to one row of the
 * PLAN §5 alignment table.
 */
export type AlignmentPlan =
	| { kind: "advance"; newIds: string[] } // k === fed.length && cur.length > k → feed cur[k:]
	| { kind: "noop" } // k === fed.length === cur.length
	| { kind: "divergence"; commonLen: number }; // k < fed.length → reset + full replay (档 A)

/**
 * Length of the longest common prefix of two entry-id sequences. Compares
 * element-wise with `===` and stops at the first mismatch or the end of either
 * array. Returns `0` for empty inputs. Runs in `O(min(a.length, b.length))`.
 *
 * Exported so the controller can surface `commonLen` directly when it needs to
 * truncate advisor state on a divergence without re-deriving it.
 */
export function longestCommonPrefixLen(
	a: readonly string[],
	b: readonly string[],
): number {
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) {
		if (a[i] !== b[i]) return i;
	}
	return n;
}

/**
 * Decide how to bring the advisor's consumed-entry sequence (`fed`) into
 * alignment with the current main branch (`cur`).
 *
 * `k = longestCommonPrefixLen(fed, cur)` partitions the outcome:
 *
 *   - `k === fed.length && cur.length > k` → **advance**: `fed` is a strict
 *     prefix of `cur`; `newIds = cur.slice(k)` is the suffix to compress and
 *     append. The slice is a fresh array, so callers may mutate it freely.
 *   - `k === fed.length && cur.length === k` → **noop**: the sequences are
 *     identical; nothing to feed. (Both empty also lands here.)
 *   - `k < fed.length` → **divergence**: `fed` has seen at least one entry past
 *     the shared prefix that is no longer on the current branch (fork, rewind,
 *     or compaction). `commonLen = k` tells the controller how much of the
 *     advisor's context is still valid; per "档 A" it resets and replays the
 *     full current branch regardless.
 *
 * Because `k <= min(fed.length, cur.length)`, the first two branches fully
 * cover the `k === fed.length` case (which implies `cur.length >= fed.length`),
 * so the `k < fed.length` branch is exhaustive for everything else.
 */
export function planAlignment(
	fed: readonly string[],
	cur: readonly string[],
): AlignmentPlan {
	const k = longestCommonPrefixLen(fed, cur);

	if (k === fed.length) {
		// fed is a prefix of (or equal to) cur.
		if (cur.length > k) {
			return { kind: "advance", newIds: cur.slice(k) };
		}
		return { kind: "noop" };
	}

	// k < fed.length: fed diverged from cur (or cur is a strict prefix of fed,
	// i.e. a rewind) — the advisor's trailing context [k:] is stale.
	return { kind: "divergence", commonLen: k };
}
