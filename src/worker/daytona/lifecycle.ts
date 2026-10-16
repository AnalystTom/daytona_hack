import type {
  CaptainInput,
  CleanupReport,
  Pod,
  RunSandbox,
} from "../../shared/sandbox";
import { type DaytonaClient, DaytonaError, type Sandbox } from "./client";

// One Daytona sandbox per run, found again by its labels so the Worker keeps no sandbox state.
export const RUN_LABEL = "reversy.run";
export const ROLE_LABEL = "reversy.role";
export const POD_KIND_LABEL = "reversy.pod-kind";
export const COPY_SNAPSHOT_LABEL = "reversy.copy-snapshot";

export const DEFAULT_SNAPSHOT = "reversy-run";
export const PREVIEW_PORT = 4173;
const PREVIEW_LINK_SECONDS = 3600;
// Where sandbox/ is installed in the snapshot (sandbox/Dockerfile).
const SCRIPTS = "/opt/reversy/sandbox";
// shortcut: a 12-hour wall-clock TTL backstops a run whose cleanup never arrives; replace it once the spend cap is decided.
const SANDBOX_TTL_MINUTES = 720;

const GONE = new Set(["destroyed", "destroying"]);
const FAILED = new Set(["error", "build_failed"]);
// States Daytona's start call brings back to "started".
const RESUMABLE = new Set(["stopped", "archived", "paused"]);

export type RunEnv = {
  runId: string;
  apiUrl: string;
  openaiApiKey: string;
  bridgeToken: string;
};

export type Deps = {
  daytona: DaytonaClient;
  snapshot: string;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  maxPolls?: number;
};

export class LifecycleError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409 | 502,
  ) {
    super(message);
  }
}

async function waitFor<T extends { state?: string; errorReason?: string }>(
  deps: Deps,
  what: string,
  read: () => Promise<T>,
  done: (state: string) => boolean,
): Promise<T> {
  const sleep =
    deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  // 150 polls of 2 s gives a sandbox five minutes to start, stop or snapshot.
  for (let poll = 0; poll < (deps.maxPolls ?? 150); poll++) {
    const current = await read();
    const state = current.state ?? "unknown";
    if (done(state)) return current;
    if (FAILED.has(state)) {
      throw new LifecycleError(
        `${what} failed in state ${state}${current.errorReason ? `: ${current.errorReason}` : ""}`,
        502,
      );
    }
    await sleep(deps.pollIntervalMs ?? 2000);
  }
  throw new LifecycleError(`${what} timed out`, 502);
}

const waitStarted = (deps: Deps, id: string) =>
  waitFor(
    deps,
    `Sandbox ${id} start`,
    () => deps.daytona.get(id),
    (s) => s === "started",
  );

const live = (sandboxes: Sandbox[]) =>
  sandboxes.filter((s) => !GONE.has(s.state ?? ""));

export async function findRunSandbox(deps: Deps, runId: string) {
  return live(
    await deps.daytona.list({ [RUN_LABEL]: runId, [ROLE_LABEL]: "run" }),
  )[0];
}

// Hands the run's secrets to the sandbox through the toolbox, so they never sit in
// Daytona's sandbox metadata, marks the boot running, then starts boot.sh in its own session.
// A boot.sh that never started is marked failed, so the next start retries it.
async function boot(deps: Deps, id: string, env: RunEnv, podId?: string) {
  const saved = await deps.daytona.exec(id, `${SCRIPTS}/save-env.sh`, {
    envs: {
      REVERSY_BOOT: "running",
      REVERSY_RUN_ID: env.runId,
      REVERSY_API_URL: env.apiUrl,
      BRIDGE_TOKEN: env.bridgeToken,
      OPENAI_API_KEY: env.openaiApiKey,
      ...(podId ? { REVERSY_POD_ID: podId } : {}),
    },
  });
  if (saved.exitCode !== 0) {
    throw new LifecycleError(
      `Saving the run environment failed: ${saved.result}`,
      502,
    );
  }
  try {
    await deps.daytona.startSessionCommand(
      id,
      `reversy-boot-${Date.now()}`,
      `${SCRIPTS}/boot.sh`,
    );
  } catch (error) {
    await deps.daytona
      .exec(id, `${SCRIPTS}/save-env.sh`, { envs: { REVERSY_BOOT: "failed" } })
      .catch(() => {});
    throw error;
  }
}

export async function startRunSandbox(
  deps: Deps,
  env: RunEnv,
): Promise<RunSandbox> {
  const existing = await findRunSandbox(deps, env.runId);
  if (existing?.state === "started") {
    const current = await summarize(deps, env.runId, existing);
    if (current.boot === "running" || current.boot === "ready") return current;
    // boot.sh is idempotent, so a failed or never-started boot is retried in place.
    await boot(deps, existing.id, env);
    return summarize(deps, env.runId, existing);
  }
  // shortcut: two simultaneous starts for one run can both create a sandbox (cleanup removes both); give the sandbox a unique per-run name if runs get concurrent starters.
  const sandbox =
    existing ??
    (await deps.daytona.create({
      snapshot: deps.snapshot,
      labels: { [RUN_LABEL]: env.runId, [ROLE_LABEL]: "run" },
      // Agents keep working without toolbox traffic, so inactivity must not stop the run.
      autoStopInterval: 0,
      ttlMinutes: SANDBOX_TTL_MINUTES,
    }));
  if (existing && RESUMABLE.has(existing.state ?? "")) {
    await deps.daytona.start(existing.id);
  }
  const started = await waitStarted(deps, sandbox.id);
  await boot(deps, sandbox.id, env);
  return summarize(deps, env.runId, started);
}

export async function getRunSandbox(
  deps: Deps,
  runId: string,
): Promise<RunSandbox | undefined> {
  const sandbox = await findRunSandbox(deps, runId);
  return sandbox && summarize(deps, runId, sandbox);
}

async function summarize(
  deps: Deps,
  runId: string,
  sandbox: Sandbox,
): Promise<RunSandbox> {
  const base = { runId, sandboxId: sandbox.id, state: sandbox.state ?? "" };
  if (sandbox.state !== "started") {
    return { ...base, boot: "unknown", bootLog: "", previewUrl: null };
  }
  // status.sh prints boot.sh's state on the first line, then the tail of its log.
  const status = await deps.daytona.exec(sandbox.id, `${SCRIPTS}/status.sh`);
  const [first = "", ...log] = status.result.split("\n");
  const preview = await deps.daytona.previewLink(
    sandbox.id,
    PREVIEW_PORT,
    PREVIEW_LINK_SECONDS,
  );
  return {
    ...base,
    boot:
      first === "running" || first === "ready" || first === "failed"
        ? first
        : "unknown",
    bootLog: log.join("\n"),
    previewUrl: preview.url,
  };
}

export async function sendCaptainInput(
  deps: Deps,
  runId: string,
  input: CaptainInput,
) {
  const target = input.podId
    ? live(await deps.daytona.list({ [RUN_LABEL]: runId })).find(
        (s) => s.id === input.podId && s.labels[ROLE_LABEL] === "pod",
      )
    : await findRunSandbox(deps, runId);
  if (!target) {
    throw new LifecycleError(
      input.podId
        ? `Run ${runId} has no pod ${input.podId}`
        : `Run ${runId} has no sandbox`,
      404,
    );
  }
  if (target.state !== "started") {
    throw new LifecycleError(
      `Sandbox ${target.id} is ${target.state ?? "in an unknown state"}, not started`,
      409,
    );
  }
  const result = await deps.daytona.exec(
    target.id,
    `${SCRIPTS}/captain-input.sh`,
    { envs: { CAPTAIN_KIND: input.kind, CAPTAIN_TEXT: input.text } },
  );
  if (result.exitCode !== 0) {
    throw new LifecycleError(
      `Firstmate did not receive the message: ${result.result}`,
      502,
    );
  }
}

// Daytona refuses fork for container sandboxes and accounts without VM fork; those
// refusals are client errors, while auth, rate-limit and server errors still surface.
const forkRefused = (error: unknown) =>
  error instanceof DaytonaError &&
  error.status >= 400 &&
  error.status < 500 &&
  error.status !== 401 &&
  error.status !== 429;

export async function createPod(
  deps: Deps,
  env: RunEnv,
  fromSandboxId?: string,
): Promise<Pod> {
  const parent = fromSandboxId
    ? live(await deps.daytona.list({ [RUN_LABEL]: env.runId })).find(
        (s) => s.id === fromSandboxId,
      )
    : await findRunSandbox(deps, env.runId);
  if (!parent) {
    throw new LifecycleError(
      `Run ${env.runId} has no sandbox${fromSandboxId ? ` ${fromSandboxId}` : ""}`,
      404,
    );
  }
  const labels = { [RUN_LABEL]: env.runId, [ROLE_LABEL]: "pod" };

  const fork = await deps.daytona.fork(parent.id).catch((error) => {
    if (forkRefused(error)) return undefined;
    throw error;
  });
  if (fork) {
    // A fork inherits its parent's labels; relabel it so it is not mistaken for the run sandbox.
    await deps.daytona.setLabels(fork.id, {
      ...labels,
      [POD_KIND_LABEL]: "fork",
    });
    await waitStarted(deps, fork.id);
    // The fork keeps the parent's running processes; only its pod id changes.
    await deps.daytona.exec(fork.id, `${SCRIPTS}/save-env.sh`, {
      envs: { REVERSY_POD_ID: fork.id },
    });
    return { podId: fork.id, kind: "fork", parentSandboxId: parent.id };
  }

  // Copy: a cold snapshot needs the parent stopped, so stop it and bring it back afterwards.
  const wasStarted = parent.state === "started";
  const snapshotName = `reversy-copy-${parent.id}-${Date.now()}`;
  let snapshotted = false;
  let copy: Sandbox;
  try {
    try {
      if (parent.state !== "stopped") {
        await deps.daytona.stop(parent.id);
        await waitFor(
          deps,
          `Sandbox ${parent.id} stop`,
          () => deps.daytona.get(parent.id),
          (s) => s === "stopped",
        );
      }
      await deps.daytona.snapshot(parent.id, snapshotName);
      snapshotted = true;
      await waitFor(
        deps,
        `Snapshot of ${parent.id}`,
        () => deps.daytona.get(parent.id),
        (s) => s !== "snapshotting",
      );
      await waitFor(
        deps,
        `Snapshot ${snapshotName}`,
        () => deps.daytona.getSnapshot(snapshotName),
        (s) => s === "active",
      );
    } finally {
      if (wasStarted) {
        await deps.daytona.start(parent.id);
        await waitStarted(deps, parent.id);
        // save-env.sh only adds variables, so a parent pod keeps its own pod id.
        await boot(deps, parent.id, env);
      }
    }
    copy = await deps.daytona.create({
      snapshot: snapshotName,
      labels: {
        ...labels,
        [POD_KIND_LABEL]: "copy",
        [COPY_SNAPSHOT_LABEL]: snapshotName,
      },
      autoStopInterval: 0,
      ttlMinutes: SANDBOX_TTL_MINUTES,
    });
  } catch (error) {
    // Cleanup finds a copy's snapshot through the pod's label, so without a pod it is removed here.
    if (snapshotted) {
      await deps.daytona.removeSnapshot(snapshotName).catch(() => {});
    }
    throw error;
  }
  await waitStarted(deps, copy.id);
  await boot(deps, copy.id, env, copy.id);
  return { podId: copy.id, kind: "copy", parentSandboxId: parent.id };
}

// Deletes every sandbox of the run (pods before the run sandbox, since Daytona keeps a
// fork parent while it has children) and the snapshots made for copies.
export async function cleanupRun(
  deps: Deps,
  runId: string,
): Promise<CleanupReport> {
  const sandboxes = live(await deps.daytona.list({ [RUN_LABEL]: runId })).sort(
    (a, b) =>
      Number(a.labels[ROLE_LABEL] === "run") -
      Number(b.labels[ROLE_LABEL] === "run"),
  );
  const removed: string[] = [];
  const failures: CleanupReport["failures"] = [];
  for (const sandbox of sandboxes) {
    try {
      await deps.daytona.remove(sandbox.id);
      removed.push(sandbox.id);
    } catch (error) {
      if (error instanceof DaytonaError && error.status === 404) {
        removed.push(sandbox.id);
      } else {
        failures.push({ id: sandbox.id, error: String(error) });
        continue;
      }
    }
    const snapshot = sandbox.labels[COPY_SNAPSHOT_LABEL];
    if (snapshot) {
      try {
        await deps.daytona.removeSnapshot(snapshot);
        removed.push(snapshot);
      } catch (error) {
        if (!(error instanceof DaytonaError && error.status === 404)) {
          failures.push({ id: snapshot, error: String(error) });
        }
      }
    }
  }
  return {
    runId,
    status: failures.length ? "failed" : "succeeded",
    removed,
    failures,
  };
}
