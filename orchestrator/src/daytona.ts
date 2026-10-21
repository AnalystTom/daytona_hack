// Daytona REST client: sandbox lifecycle + toolbox (exec, async sessions, files).
import type { Env } from "./types";

export class SandboxCleanupError extends Error {
  constructor(id: string | undefined, cause: unknown) {
    super(
      `${id ? `Sandbox ${id} cleanup` : "Sandbox allocation"} unconfirmed: ${String(cause)}`,
      { cause },
    );
  }
}

class DaytonaResponseError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class Daytona {
  private toolbox = new Map<string, string>();
  constructor(private env: Env) {}

  private headers(json = true): HeadersInit {
    const h: Record<string, string> = {
      Authorization: `Bearer ${this.env.DAYTONA_API_KEY}`,
    };
    if (json) h["Content-Type"] = "application/json";
    return h;
  }

  private async call<T = any>(url: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(url, {
      ...init,
      headers: { ...this.headers(), ...(init.headers || {}) },
    });
    const text = await res.text();
    if (!res.ok)
      throw new DaytonaResponseError(
        res.status,
        `daytona ${init.method || "GET"} ${url.split("?")[0]} ${res.status}: ${text.slice(0, 300)}`,
      );
    return (text ? JSON.parse(text) : {}) as T;
  }

  async create(
    opts: {
      env?: Record<string, string>;
      snapshot?: string;
      labels?: Record<string, string>;
      autoStopInterval?: number; // minutes idle before stopping
      autoDeleteInterval?: number; // minutes stopped before deleting; 0 deletes on stop
    },
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    let sb: { id: string };
    try {
      sb = await this.call(`${this.env.DAYTONA_API_URL}/sandbox`, {
        method: "POST",
        signal: AbortSignal.any([
          AbortSignal.timeout(30_000),
          ...(signal ? [signal] : []),
        ]),
        body: JSON.stringify({
          target: this.env.DAYTONA_TARGET,
          env: opts.env || {},
          snapshot: opts.snapshot,
          labels: opts.labels || {},
          public: false,
          autoStopInterval: opts.autoStopInterval ?? 60,
          ...(opts.autoDeleteInterval !== undefined && {
            autoDeleteInterval: opts.autoDeleteInterval,
          }),
        }),
      });
      if (typeof sb?.id !== "string" || !sb.id)
        throw new Error("Daytona returned no sandbox ID");
    } catch (error) {
      if (error instanceof DaytonaResponseError && error.status < 500)
        throw error;
      throw new SandboxCleanupError(undefined, error);
    }
    try {
      for (let i = 0; i < 60; i++) {
        signal?.throwIfAborted();
        const s = await this.get(sb.id, signal);
        signal?.throwIfAborted();
        if (s.state === "started") return s;
        if (s.state === "error" || s.state === "build_failed")
          throw new Error(`sandbox ${sb.id} ${s.state}`);
        await sleep(2000, signal);
      }
      throw new Error(`sandbox ${sb.id} did not start`);
    } catch (error) {
      await this.remove(sb.id);
      throw error;
    }
  }

  get(id: string, signal?: AbortSignal) {
    return this.call(`${this.env.DAYTONA_API_URL}/sandbox/${id}`, { signal });
  }

  async remove(id: string) {
    try {
      await this.call(`${this.env.DAYTONA_API_URL}/sandbox/${id}`, {
        method: "DELETE",
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new SandboxCleanupError(id, error);
    }
  }

  async previewUrl(id: string, port: number): Promise<string> {
    const r = await this.call(
      `${this.env.DAYTONA_API_URL}/sandbox/${id}/ports/${port}/preview-url`,
    );
    return r.url;
  }

  /** A preview link that works without headers until it expires. */
  async signedPreviewUrl(id: string, port: number, seconds: number) {
    const r = await this.call<{ url: string }>(
      `${this.env.DAYTONA_API_URL}/sandbox/${id}/ports/${port}/signed-preview-url?expiresInSeconds=${seconds}`,
    );
    return r.url;
  }

  private async tb(id: string, signal?: AbortSignal): Promise<string> {
    if (!this.toolbox.has(id)) {
      const r = await this.call(
        `${this.env.DAYTONA_API_URL}/sandbox/${id}/toolbox-proxy-url`,
        { signal },
      );
      this.toolbox.set(id, `${r.url}/${id}`);
    }
    return this.toolbox.get(id)!;
  }

  /** Run a short command and wait for it. */
  async exec(
    id: string,
    command: string,
    opts: { cwd?: string; timeout?: number; signal?: AbortSignal } = {},
  ) {
    const r = await this.call<{ exitCode: number; result: string }>(
      `${await this.tb(id, opts.signal)}/process/execute`,
      {
        method: "POST",
        signal: opts.signal,
        body: JSON.stringify({
          command: `bash -lc ${shq(command)}`,
          cwd: opts.cwd,
          timeout: opts.timeout ?? 120,
        }),
      },
    );
    return r;
  }

  async must(
    id: string,
    command: string,
    opts: { cwd?: string; timeout?: number } = {},
  ) {
    const r = await this.exec(id, command, opts);
    if (r.exitCode !== 0)
      throw new Error(
        `command failed (${r.exitCode}): ${command.slice(0, 120)}\n${r.result.slice(-800)}`,
      );
    return r.result;
  }

  /** Start a long command in its own session; returns immediately. */
  async startAsync(
    id: string,
    sessionId: string,
    command: string,
    beforeWork?: () => Promise<void>,
  ) {
    const base = await this.tb(id);
    await beforeWork?.();
    await fetch(`${base}/process/session`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ sessionId }),
    });
    await beforeWork?.();
    const r = await this.call<{ cmdId: string }>(
      `${base}/process/session/${sessionId}/exec`,
      {
        method: "POST",
        body: JSON.stringify({
          command: `bash -lc ${shq(command)}`,
          runAsync: true,
        }),
      },
    );
    return r.cmdId;
  }

  async writeFile(
    id: string,
    path: string,
    content: string | ArrayBuffer | Uint8Array,
    signal?: AbortSignal,
  ) {
    const form = new FormData();
    form.append("file", new Blob([content]), path.split("/").pop());
    const res = await fetch(
      `${await this.tb(id, signal)}/files/upload?path=${encodeURIComponent(path)}`,
      {
        method: "POST",
        signal,
        headers: this.headers(false),
        body: form,
      },
    );
    if (!res.ok)
      throw new Error(
        `upload ${path} ${res.status}: ${(await res.text()).slice(0, 200)}`,
      );
  }
}

export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    signal?.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
