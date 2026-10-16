// Daytona REST adapter. Paths and payloads follow Daytona's public API as used by
// @daytona/sdk and @daytona/api-client 0.224.1. Plain fetch keeps the Worker bundle
// free of the SDK's Node-only dependencies and lets tests inject a mock fetch.

export const DEFAULT_DAYTONA_API_URL = "https://app.daytona.io/api";

export type Labels = Record<string, string>;

export type Sandbox = {
  id: string;
  name: string;
  state?: string;
  labels: Labels;
  errorReason?: string;
};

export type ExecResult = { exitCode: number; result: string };
export type PreviewLink = { url: string; token?: string };

export type CreateSandboxInput = {
  snapshot: string;
  labels: Labels;
  env?: Record<string, string>;
  autoStopInterval?: number;
  ttlMinutes?: number;
};

export class DaytonaError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "DaytonaError";
  }
}

type ClientOptions = {
  apiKey: string;
  apiUrl?: string;
  fetch?: typeof fetch;
};

export type DaytonaClient = ReturnType<typeof createDaytonaClient>;

export function createDaytonaClient({
  apiKey,
  apiUrl = DEFAULT_DAYTONA_API_URL,
  fetch: doFetch = (input, init) => fetch(input, init),
}: ClientOptions) {
  const toolboxBases = new Map<string, string>();

  async function call<T>(
    url: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const response = await doFetch(url, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        ...(init.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new DaytonaError(
        `Daytona ${init.method ?? "GET"} ${new URL(url).pathname} failed with ${response.status}: ${text.slice(0, 500)}`,
        response.status,
      );
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  const api = <T>(path: string, init?: { method?: string; body?: unknown }) =>
    call<T>(`${apiUrl}${path}`, init);

  const sandboxPath = (id: string) => `/sandbox/${encodeURIComponent(id)}`;

  async function toolbox<T>(
    id: string,
    path: string,
    init?: { method?: string; body?: unknown },
  ): Promise<T> {
    let base = toolboxBases.get(id);
    if (!base) {
      const { url } = await api<{ url: string }>(
        `${sandboxPath(id)}/toolbox-proxy-url`,
      );
      base = `${url.replace(/\/$/, "")}/${encodeURIComponent(id)}`;
      toolboxBases.set(id, base);
    }
    return call<T>(`${base}${path}`, init);
  }

  return {
    create: (input: CreateSandboxInput) =>
      api<Sandbox>("/sandbox", { method: "POST", body: input }),

    get: (id: string) => api<Sandbox>(sandboxPath(id)),

    // shortcut: reads one page of 100, enough for one run's sandbox and its pods; follow nextCursor if that grows.
    list: async (labels: Labels) =>
      (
        await api<{ items: Sandbox[] }>(
          `/sandbox?limit=100&labels=${encodeURIComponent(JSON.stringify(labels))}`,
        )
      ).items,

    start: (id: string) =>
      api<Sandbox>(`${sandboxPath(id)}/start`, { method: "POST" }),

    stop: (id: string) =>
      api<Sandbox>(`${sandboxPath(id)}/stop`, { method: "POST" }),

    remove: (id: string) => api<Sandbox>(sandboxPath(id), { method: "DELETE" }),

    fork: (id: string, name?: string) =>
      api<Sandbox>(`${sandboxPath(id)}/fork`, {
        method: "POST",
        body: { name },
      }),

    // Cold snapshot of a stopped sandbox; the sandbox reports "snapshotting" until it is done.
    snapshot: (id: string, name: string) =>
      api<Sandbox>(`${sandboxPath(id)}/snapshot`, {
        method: "POST",
        body: { name },
      }),

    getSnapshot: (nameOrId: string) =>
      api<{ id: string; name: string; state: string; errorReason?: string }>(
        `/snapshots/${encodeURIComponent(nameOrId)}`,
      ),

    // The delete endpoint takes the snapshot id, so resolve the name first.
    removeSnapshot: async (name: string) => {
      const { id } = await api<{ id: string }>(
        `/snapshots/${encodeURIComponent(name)}`,
      );
      await api(`/snapshots/${encodeURIComponent(id)}`, { method: "DELETE" });
    },

    setLabels: (id: string, labels: Labels) =>
      api<{ labels: Labels }>(`${sandboxPath(id)}/labels`, {
        method: "PUT",
        body: { labels },
      }),

    previewLink: (id: string, port: number, expiresInSeconds: number) =>
      api<PreviewLink>(
        `${sandboxPath(id)}/ports/${port}/signed-preview-url?expiresInSeconds=${expiresInSeconds}`,
      ),

    exec: async (
      id: string,
      command: string,
      {
        envs,
        timeoutSeconds = 60,
      }: { envs?: Record<string, string>; timeoutSeconds?: number } = {},
    ): Promise<ExecResult> => {
      const response = await toolbox<{
        exitCode?: number;
        code?: number;
        result?: string;
      }>(id, "/process/execute", {
        method: "POST",
        body: { command, envs, timeout: timeoutSeconds },
      });
      // Older toolbox versions name the field `code`, as the SDK also accepts.
      return {
        exitCode: response.exitCode ?? response.code ?? 0,
        result: response.result ?? "",
      };
    },

    // Starts a long-running command in its own session without waiting for it.
    startSessionCommand: async (
      id: string,
      sessionId: string,
      command: string,
    ) => {
      await toolbox(id, "/process/session", {
        method: "POST",
        body: { sessionId },
      });
      const { cmdId } = await toolbox<{ cmdId: string }>(
        id,
        `/process/session/${encodeURIComponent(sessionId)}/exec`,
        { method: "POST", body: { command, runAsync: true } },
      );
      return cmdId;
    },
  };
}
