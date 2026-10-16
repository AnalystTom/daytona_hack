import type { EvidenceItem } from "../../shared/contracts";
import {
  type CaptureEvent,
  type CaptureRequest,
  type EvidenceRecord,
  inScope,
  viewports,
} from "../../shared/evidence";
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
  // The run API's event function; it adds the envelope (IDs, sequence, timestamp).
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

const signedInLimit =
  "Captured in the user's signed-in session; Anchor's sensitive-data masking covers the rendered page, but the DOM and network log may still hold account data.";

// Captures evidence for every approved path, or starts/resumes a secure sign-in.
export async function captureRun(
  deps: CaptureDeps,
  runId: string,
  request: CaptureRequest,
): Promise<CaptureResult> {
  const { scope, mode } = request;
  const full = mode === "full_pack";
  const key = deps.anchorApiKey;

  if (request.signIn === "start") {
    // The user types credentials into Anchor's live view; Reversy never receives them.
    const session = await anchor.createSession(key, {
      recording: false,
      signInUrl: `${scope.origin}${scope.paths[0]}`,
    });
    await deps.store.saveSignIn(runId, {
      sessionId: session.id,
      origin: scope.origin,
    });
    await deps.emit({
      type: "evidence.sign_in_requested",
      state: "awaiting_sign_in",
      message: "Open secure sign-in and sign in yourself, then resume capture.",
      artifactRefs: [],
    });
    return { status: "awaiting_sign_in", liveViewUrl: session.liveViewUrl };
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

  const items: EvidenceRecord[] = [];
  const save = async (
    expected: Expected,
    label: EvidenceRecord["label"],
    contentType: string,
    content: Uint8Array,
    limitations: string[],
  ) => {
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
    await deps.store.putEvidence(record, content);
    items.push(record);
    return record.id;
  };
  const notObserved = (expected: Expected, reason: string) =>
    save(expected, "not_observed", "text/plain", new Uint8Array(), [reason]);

  const capturePage = async (path: string) => {
    const url = `${scope.origin}${path}`;
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
    ) => {
      const expected = pending.shift() as Expected;
      ids.push(
        await save(expected, "observed", contentType, content, limitations),
      );
    };
    let stopped: string | undefined;

    try {
      const facts = await anchor.runSnippet<anchor.PageFacts>(
        key,
        sessionId,
        anchor.navigateSnippet(url, scope.origin, full),
      );
      if (!inScope(facts.finalUrl, scope)) {
        stopped = `Redirected to ${facts.finalUrl}, outside the approved scope; capture stopped for this page.`;
      } else {
        if (full) {
          await take("text/html", encoder.encode(facts.html ?? ""), [
            "Rendered DOM after load; content added on scroll or interaction is missing.",
          ]);
          await take("application/json", json(facts.styles), [
            "Most frequent computed values on up to 5000 elements, plus :root custom properties from readable stylesheets; names are not the site's own tokens.",
          ]);
          await take("application/json", json(facts.assets), [
            "Images, icons and fonts present after load; reuse needs permission.",
          ]);
          await take("application/json", json(facts.network), [
            "Requests during page load only; response shapes keep keys and types, not values; headers and bodies are not kept.",
          ]);
        }
        for (const [, viewport] of shots) {
          const shot = await anchor.runSnippet<{
            finalUrl: string;
            png: string;
          }>(key, sessionId, anchor.screenshotSnippet(viewport));
          if (!inScope(shot.finalUrl, scope)) {
            stopped = `Page moved to ${shot.finalUrl}, outside the approved scope; capture stopped for this page.`;
            break;
          }
          await take("image/png", fromBase64(shot.png), [
            "Full-page capture after load; lazy-loaded or animated content may differ.",
          ]);
        }
      }
    } catch (error) {
      // Only browser failures become not_observed; storage failures must fail the capture.
      if (!(error instanceof anchor.AnchorError)) throw error;
      stopped = `Capture failed: ${error.message}`;
    }

    for (const expected of pending)
      ids.push(await notObserved(expected, stopped ?? ""));
    await deps.emit({
      type: stopped ? "evidence.page_stopped" : "evidence.page_captured",
      state: "capturing",
      message: stopped ? `${path}: ${stopped}` : `Captured ${path}`,
      artifactRefs: ids,
    });
  };

  try {
    for (const path of scope.paths) await capturePage(path);
  } finally {
    // Anchor also ends idle sessions itself, so a failed close only costs a few idle minutes.
    await anchor.endSession(key, sessionId).catch(() => {});
  }

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
    } else {
      try {
        const video = await anchor.primaryRecording(key, sessionId);
        if (video) {
          await save(recording, "observed", "video/mp4", video, [
            "Page-load recording of the whole capture session; no interactions were performed.",
          ]);
        } else {
          await notObserved(
            recording,
            "Anchor had no recording ready when capture ended.",
          );
        }
      } catch (error) {
        await notObserved(
          recording,
          `Recording fetch failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  await deps.emit({
    type: "evidence.capture_finished",
    state: "captured",
    message: `${items.filter((item) => item.label === "observed").length} of ${items.length} evidence items observed`,
    artifactRefs: items.map((item) => item.id),
  });
  return { status: "captured", items };
}
