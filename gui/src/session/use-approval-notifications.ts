/**
 * OS notification when an approval arrives while the app is unfocused
 * (T4, issue #5; spec issue #1 story #15: "a sidebar badge and an OS
 * notification... so that a blocked agent never idles unnoticed").
 *
 * Watches every tracked session through the store-wide `ApprovalRegistry`,
 * not just whichever one is currently mounted — a background session's
 * approval must notify just as loudly as the active session's, see
 * `approvals.ts`'s registry comment.
 *
 * No Tauri notification plugin is wired into this app (absent from both
 * `Cargo.toml` and `gui/package.json`), so this always uses the standard
 * Web Notification API, which the Tauri webview implements natively.
 */
import { useEffect } from "react";
import { getApprovalRegistry, type ApprovalRequest, type SessionsStore } from "@omp-gui/ipc";

/** The notification body per variant — every blocking request carries a
 * `title` (used as the notification title instead), so this only needs to
 * add the detail that `title` alone wouldn't convey. */
function describeApprovalRequest(request: ApprovalRequest): string {
  switch (request.method) {
    case "confirm":
      return request.message;
    case "select":
      return request.options.join(" / ");
    case "input":
      return request.placeholder ?? "Waiting for your input";
    case "editor":
      return "Waiting for your input";
  }
}

/**
 * Mount once alongside the approval inbox. Requests notification
 * permission on mount (a no-op if already granted or denied) so it is
 * ready by the time a real approval arrives instead of racing an async
 * permission prompt against it.
 */
export function useApprovalNotifications(store: SessionsStore): void {
  useEffect(() => {
    if (typeof Notification === "undefined") return;
    if (Notification.permission === "default") void Notification.requestPermission();

    return getApprovalRegistry(store).onRequest((sessionId, pending) => {
      if (Notification.permission !== "granted") return;
      const unfocused = document.hidden || !document.hasFocus();
      if (!unfocused) return;
      const sessionTitle = store.list().find((session) => session.id === sessionId)?.title ?? "omp";
      new Notification(`${sessionTitle}: ${pending.request.title}`, {
        body: describeApprovalRequest(pending.request),
        tag: pending.request.id,
      });
    });
  }, [store]);
}
