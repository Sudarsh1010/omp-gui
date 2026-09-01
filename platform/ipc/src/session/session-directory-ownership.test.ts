/**
 * Fast unit guard for {@link SessionDirectory.ownerOf}'s snapshot-stability
 * contract. `gui/src/session/use-session-directory.ts` feeds `ownerOf` to
 * React's `useSyncExternalStore`, which compares successive snapshots with
 * `Object.is`: if `ownerOf` returns a fresh object every call for an
 * unchanged claim, React sees the snapshot "change" on every render and
 * loops until it throws "Maximum update depth exceeded" (the reported bug).
 *
 * No omp binary here (unlike the sibling seam test) — this pins a pure
 * referential-identity invariant, so a fake store/bridge is exactly right.
 */
import { describe, expect, it } from "vite-plus/test";
import type { ShellBridge } from "../bridge/shell-bridge";
import type { SessionsStore } from "./sessions-store";
import { createSessionDirectory } from "./session-directory";

function fakeStore(): SessionsStore {
  return {
    subscribe: () => () => {},
    list: () => [],
  } as unknown as SessionsStore;
}

describe("SessionDirectory.ownerOf snapshot stability", () => {
  it("returns a referentially stable snapshot for an unchanged claim", () => {
    const directory = createSessionDirectory({} as ShellBridge, fakeStore());
    const first = directory.ownerOf("/tmp/session-a.jsonl");
    const second = directory.ownerOf("/tmp/session-a.jsonl");
    // useSyncExternalStore compares with Object.is; a fresh object here is
    // the infinite-render loop.
    expect(Object.is(first, second)).toBe(true);
    expect(second).toEqual({ state: "free" });
    directory.dispose();
  });
});
