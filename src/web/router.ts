import { type MouseEvent, useSyncExternalStore } from "react";

// Minimal client router: pathname from the History API, re-read on back/forward and on navigate().
const changeEvent = "reversy:navigate";

function subscribe(onChange: () => void) {
  window.addEventListener("popstate", onChange);
  window.addEventListener(changeEvent, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(changeEvent, onChange);
  };
}

export function usePath() {
  return useSyncExternalStore(subscribe, () => window.location.pathname);
}

/** Pushes a history entry. Throws if `state` cannot be stored (for example too large to clone). */
export function navigate(to: string, state: unknown = null) {
  window.history.pushState(state, "", to);
  window.scrollTo({ top: 0, behavior: "instant" });
  window.dispatchEvent(new Event(changeEvent));
}

/** onClick for in-app <a href>: keeps new-tab and modified clicks native. */
export function followLink(event: MouseEvent<HTMLAnchorElement>) {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return;
  }
  event.preventDefault();
  navigate(event.currentTarget.getAttribute("href") ?? "/");
}
