import { abortable } from "../../shared/cancellation";
import type { EvidenceItem } from "../../shared/contracts";
import {
  type CaptureEvent,
  type CaptureRequest,
  type EvidenceRecord,
  inScope,
  leftScope,
  redactQuery,
  viewports,
} from "../../shared/evidence";
import { checkTargetUrl } from "../runs/url";
import * as anchor from "./anchor";
import { type EvidenceStore, fromBase64 } from "./store";

export class CaptureError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export type CaptureResult =
  | { status: "awaiting_sign_in"; liveViewUrl: string }
  | { status: "captured"; items: EvidenceRecord[] };

export interface CaptureDeps {
  anchorApiKey: string;
  store: EvidenceStore;
  signal?: AbortSignal;
  beforeWork?: () => Promise<void>;
  onSession?: (close: () => Promise<void>) => void;
  waitUntil?: (work: Promise<unknown>) => void;
  // Appends the event to the run; the caller adds the envelope (IDs, sequence, timestamp).
  emit: (event: CaptureEvent) => void | Promise<void>;
}

type Kind = EvidenceItem["kind"];
interface Expected {
  kind: Kind;
  pageOrState: string;
  url: string;
}

const encoder = new TextEncoder();
const json = (value: unknown) => encoder.encode(JSON.stringify(value));

async function sha256(bytes: Uint8Array) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `sha256:${Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export const recordingCapMs = 30_000;
export { leftScope } from "../../shared/evidence";

const noCodeExecution = "Anchor code execution is not enabled on this account";

// HTTP preflight rejects known off-scope landings; it cannot verify the screenshot tool's final URL.
// Every hop must pass the run URL checks (https, public host) before it is fetched.
const maxHops = 5;
async function landingUrl(start: string) {
  let current = start;
  for (let hop = 0; hop <= maxHops; hop++) {
    const checked = checkTargetUrl(current);
    if ("error" in checked)
      throw new anchor.AnchorError(
        `a redirect hop was refused: ${checked.error}`,
      );
    try {
      const response = await fetch(checked.url, {
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
        headers: { "User-Agent": "Mozilla/5.0 (Macintosh) Reversy-Inspector" },
      });
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (response.status < 300 || response.status > 399 || !location)
        return checked.url;
      current = new URL(location, checked.url).href;
    } catch {
      throw new anchor.AnchorError(
        "the page's final URL could not be checked against the approved scope",
      );
    }
  }
  throw new anchor.AnchorError("the page redirected too many times");
}

const signedInLimit =
  "Captured in the user's signed-in session; it may show account data.";
const signedInSkipped =
  "Signed-in DOM, assets and network are not captured until masking exists.";

// Ends the run's saved sign-in session, if any; an end failure is left to Anchor's timeout.
export async function endSignIn(
  deps: Pick<CaptureDeps, "anchorApiKey" | "store">,
  runId: string,
) {
  const signIn = await deps.store.takeSignIn(runId);
  if (signIn)
    await anchor
      .endSession(deps.anchorApiKey, signIn.sessionId)
      .catch(() => {});
}

// Captures evidence for every approved path, or starts/resumes a secure sign-in.
export async function captureRun(
  deps: CaptureDeps,
  runId: string,
  request: CaptureRequest,
): Promise<CaptureResult> {
  const work = captureWork(deps, runId, request);
  deps.waitUntil?.(work.catch(() => {}));
  return abortable(work, deps.signal);
}

async function captureWork(
  deps: CaptureDeps,
  runId: string,
  request: CaptureRequest,
): Promise<CaptureResult> {
  deps.signal?.throwIfAborted();
  await deps.beforeWork?.();
  const { scope, mode } = request;
  const full = mode === "full_pack";
  const key = deps.anchorApiKey;

  if (request.signIn === "start") {
    // The user types credentials into Anchor's live view; Reversy never receives them.
    const session = await anchor.createSession(key, {
      recording: false,
      signInUrl: `${scope.origin}${scope.paths[0]}`,
    });
    let closing: Promise<void> | undefined;
    const close = () =>
      (closing ??= anchor.endSession(key, session.id).catch(() => {}));
    deps.onSession?.(close);
    const abort = () => {
      void close();
    };
    deps.signal?.addEventListener("abort", abort, { once: true });
    try {
      deps.signal?.throwIfAborted();
      await endSignIn(deps, runId);
      deps.signal?.throwIfAborted();
      await deps.store.saveSignIn(runId, {
        sessionId: session.id,
        origin: scope.origin,
      });
      deps.signal?.throwIfAborted();
      await deps.emit({
        type: "evidence.sign_in_requested",
        state: "awaiting_sign_in",
        message:
          "Open secure sign-in and sign in yourself, then resume capture.",
        artifactRefs: [],
      });
      deps.signal?.throwIfAborted();
      return { status: "awaiting_sign_in", liveViewUrl: session.liveViewUrl };
    } catch (error) {
      // Forget a save that committed after cancellation without waiting for Anchor.
      await Promise.all([deps.store.takeSignIn(runId), close()]);
      throw error;
    } finally {
      deps.signal?.removeEventListener("abort", abort);
    }
  }

  const signedIn = request.signIn === "resume";
  let sessionId: string;
  if (signedIn) {
    const signIn = await deps.store.takeSignIn(runId);
    if (!signIn) {
      throw new CaptureError(
        "No sign-in session to resume for this run; start sign-in first.",
        409,
      );
    }
    // A signed-in session only ever captures the origin the user signed in to.
    if (signIn.origin !== scope.origin) {
      await anchor.endSession(key, signIn.sessionId).catch(() => {});
      throw new CaptureError(
        "The sign-in session belongs to a different origin; start sign-in again.",
        409,
      );
    }
    sessionId = signIn.sessionId;
  } else {
    sessionId = (await anchor.createSession(key, { recording: full })).id;
  }
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= anchor.endSession(key, sessionId).catch(() => {}));
  // Recordings are capped at 30 seconds: pause it then, however long the pages take.
  let capMissed = false;
  let pausing: Promise<void> | undefined;
  const cap =
    full && !signedIn
      ? setTimeout(() => {
          pausing = anchor.pauseRecording(key, sessionId).catch(() => {
            capMissed = true;
          });
        }, recordingCapMs)
      : undefined;
  const abort = () => {
    if (cap !== undefined) clearTimeout(cap);
    void close();
  };
  deps.signal?.addEventListener("abort", abort, { once: true });

  const items: EvidenceRecord[] = [];
  const save = async (
    expected: Expected,
    label: EvidenceRecord["label"],
    contentType: string,
    content: Uint8Array,
    limitations: string[],
  ) => {
    deps.signal?.throwIfAborted();
    const record: EvidenceRecord = {
      id: `ev_${crypto.randomUUID()}`,
      runId,
      ...expected,
      label,
      tool: "anchor",
      capturedAt: new Date().toISOString(),
      contentHash: await sha256(content),
      limitations: signedIn ? [...limitations, signedInLimit] : limitations,
      contentType,
      byteLength: content.length,
    };
    deps.signal?.throwIfAborted();
    await deps.store.putEvidence(record, content, deps.signal);
    deps.signal?.throwIfAborted();
    items.push(record);
    return record.id;
  };
  // Set on the first refusal and kept for this capture pass, so execute-code is not retried per page.
  let fallback = false;
  // Final URLs of pages that left the scope; the session recording shows them too.
  const outOfScope: string[] = [];
  const notObserved = (expected: Expected, reason: string) =>
    save(expected, "not_observed", "text/plain", new Uint8Array(), [reason]);

  const capturePage = async (path: string) => {
    deps.signal?.throwIfAborted();
    const url = `${scope.origin}${path}`;
    let documentUrl = url;
    const pageScope = { origin: scope.origin, paths: [path] };
    const shots = Object.entries(
      full ? viewports : { desktop: viewports.desktop },
    );
    const pending: Expected[] = [
      ...(full ? (["dom", "styles", "assets", "network"] as const) : []).map(
        (kind) => ({ kind, pageOrState: path, url }),
      ),
      ...shots.map(([name, viewport]) => ({
        kind: "screenshot" as const,
        pageOrState: `${path} @ ${name} ${viewport.width}`,
        url,
      })),
    ];
    const ids: string[] = [];
    const take = async (
      contentType: string,
      content: Uint8Array,
      limitations: string[],
      label: EvidenceRecord["label"] = "observed",
    ) => {
      const expected = pending.shift() as Expected;
      ids.push(
        await save(
          { ...expected, url: documentUrl },
          label,
          contentType,
          content,
          limitations,
        ),
      );
    };
    const skip = async (reason: string) => {
      ids.push(await notObserved(pending.shift() as Expected, reason));
    };
    // `stopped` goes into the gated evidence; `shown` into the run's event stream.
    let stopped: string | undefined;
    let shown: string | undefined;
    const leave = (verb: string, finalUrl: string) => {
      outOfScope.push(finalUrl);
      const reason = (target: string) =>
        `${verb} ${target}, ${leftScope}; capture stopped for this page.`;
      stopped = reason(finalUrl);
      shown = reason(redactQuery(finalUrl));
    };

    try {
      await deps.beforeWork?.();
      let facts: anchor.PageFacts | undefined;
      if (!fallback) {
        try {
          facts = await anchor.runSnippet<anchor.PageFacts>(
            key,
            sessionId,
            anchor.navigateSnippet(url, scope.origin, full),
          );
        } catch (error) {
          // A signed-in session only works through code execution, so it fails as before.
          if (!(error instanceof anchor.CodeExecutionRefused) || signedIn)
            throw error;
          fallback = true;
        }
      }
      const finalUrl = facts?.finalUrl ?? (await landingUrl(url));
      deps.signal?.throwIfAborted();
      if (!inScope(finalUrl, pageScope)) {
        leave("Redirected to", finalUrl);
      } else {
        documentUrl = finalUrl;
        if (full && !facts) {
          for (let n = 0; n < 4; n++) await skip(noCodeExecution);
        } else if (full && facts) {
          if (signedIn) await skip(signedInSkipped);
          else
            await take("text/html", encoder.encode(facts.html ?? ""), [
              "Rendered DOM after load; content added on scroll or interaction is missing.",
            ]);
          await take("application/json", json(facts.styles), [
            "Most frequent computed values on up to 5000 elements, plus :root custom properties from readable stylesheets; names are not the site's own tokens.",
          ]);
          if (signedIn) await skip(signedInSkipped);
          else
            await take("application/json", json(facts.assets), [
              "Images, icons and fonts present after load; reuse needs permission.",
            ]);
          if (signedIn) await skip(signedInSkipped);
          else
            await take("application/json", json(facts.network), [
              "Requests during page load only; response shapes keep keys and types, not values; headers and bodies are not kept.",
            ]);
        }
        for (const [, viewport] of shots) {
          deps.signal?.throwIfAborted();
          await deps.beforeWork?.();
          const limit =
            "Full-page capture after load; lazy-loaded or animated content may differ.";
          if (fallback) {
            const png = await anchor.screenshotTool(
              key,
              sessionId,
              url,
              viewport,
            );
            deps.signal?.throwIfAborted();
            await take(
              "image/png",
              png,
              [
                limit,
                "captured with the fallback screenshot tool; the final page URL after scripts could not be verified, so it may show a redirect such as a sign-in page",
              ],
              "inferred",
            );
            continue;
          }
          const shot = await anchor.runSnippet<{
            finalUrl: string;
            png: string;
          }>(key, sessionId, anchor.screenshotSnippet(viewport));
          deps.signal?.throwIfAborted();
          if (!inScope(shot.finalUrl, pageScope)) {
            leave("Page moved to", shot.finalUrl);
            break;
          }
          documentUrl = shot.finalUrl;
          await take("image/png", fromBase64(shot.png), [limit]);
        }
      }
    } catch (error) {
      deps.signal?.throwIfAborted();
      // Only browser failures become not_observed; storage failures must fail the capture.
      if (!(error instanceof anchor.AnchorError)) throw error;
      if (signedIn)
        throw new CaptureError(
          "The sign-in session could not be captured; open secure sign-in again.",
          409,
        );
      stopped = `Capture failed: ${error.message}`;
      shown = redactQuery(stopped);
    }

    while (pending.length) await skip(stopped ?? "");
    deps.signal?.throwIfAborted();
    await deps.emit({
      type: stopped ? "evidence.page_stopped" : "evidence.page_captured",
      state: "capturing",
      message: stopped
        ? `${redactQuery(path)}: ${shown}`
        : `Captured ${redactQuery(path)}`,
      artifactRefs: ids,
    });
  };

  try {
    deps.onSession?.(close);
    deps.signal?.throwIfAborted();
    for (const path of scope.paths) await capturePage(path);
  } finally {
    deps.signal?.removeEventListener("abort", abort);
    if (cap !== undefined) clearTimeout(cap);
    // Closing must still start when pausing a recording stalls.
    await Promise.all([pausing, close()]);
  }

  deps.signal?.throwIfAborted();
  if (full) {
    const recording: Expected = {
      kind: "recording",
      pageOrState: `session: ${scope.paths.join(", ")}`,
      url: `${scope.origin}${scope.paths[0]}`,
    };
    if (signedIn) {
      await notObserved(
        recording,
        "Recording is off in signed-in sessions so the user's sign-in is never recorded.",
      );
    } else if (fallback) {
      await notObserved(recording, noCodeExecution);
    } else if (capMissed) {
      await notObserved(
        recording,
        "Recording was not kept because pausing it at 30 seconds failed.",
      );
    } else if (outOfScope.length) {
      await notObserved(
        recording,
        `Session left the approved scope: ${outOfScope.join(", ")}`,
      );
    } else {
      try {
        await deps.beforeWork?.();
        const video = await anchor.primaryRecording(key, sessionId);
        if (video) {
          await save(recording, "observed", "video/mp4", video, [
            "Page-load recording of the first 30 seconds of the capture session; no interactions were performed.",
          ]);
        } else {
          await notObserved(
            recording,
            "Anchor had no recording ready when capture ended.",
          );
        }
      } catch (error) {
        if (!(error instanceof anchor.AnchorError)) throw error;
        await notObserved(
          recording,
          `Recording fetch failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  deps.signal?.throwIfAborted();
  await deps.emit({
    type: "evidence.capture_finished",
    state: "captured",
    message: `${items.filter((item) => item.label === "observed").length} observed, ${items.filter((item) => item.label === "inferred").length} inferred, ${items.filter((item) => item.label === "not_observed").length} not observed`,
    artifactRefs: items.map((item) => item.id),
  });
  return { status: "captured", items };
}
