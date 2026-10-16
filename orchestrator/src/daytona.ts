// Daytona REST client: sandbox lifecycle + toolbox (exec, async sessions, files).
import type { Env } from "./types";

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
      throw new Error(
        `daytona ${init.method || "GET"} ${url.split("?")[0]} ${res.status}: ${text.slice(0, 300)}`,
      );
    return (text ? JSON.parse(text) : {}) as T;
  }

  async create(opts: {
    env?: Record<string, string>;
    snapshot?: string;
    labels?: Record<string, string>;
  }) {
    const sb = await this.call(`${this.env.DAYTONA_API_URL}/sandbox`, {
      method: "POST",
      body: JSON.stringify({
        target: this.env.DAYTONA_TARGET,
        env: opts.env || {},
        snapshot: opts.snapshot,
        labels: opts.labels || {},
        public: false, // the preview is reached only through short-lived signed links
        autoStopInterval: 60,
      }),
    });
    for (let i = 0; i < 60; i++) {
      const s = await this.get(sb.id);
      if (s.state === "started") return s;
      if (s.state === "error" || s.state === "build_failed")
        throw new Error(`sandbox ${sb.id} ${s.state}`);
      await sleep(2000);
    }
    throw new Error(`sandbox ${sb.id} did not start`);
  }

  get(id: string) {
    return this.call(`${this.env.DAYTONA_API_URL}/sandbox/${id}`);
  }

  async remove(id: string) {
    await this.call(`${this.env.DAYTONA_API_URL}/sandbox/${id}`, {
      method: "DELETE",
    });
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

  private async tb(id: string): Promise<string> {
    if (!this.toolbox.has(id)) {
      const r = await this.call(
        `${this.env.DAYTONA_API_URL}/sandbox/${id}/toolbox-proxy-url`,
      );
      this.toolbox.set(id, `${r.url}/${id}`);
    }
    return this.toolbox.get(id)!;
  }

  /** Run a short command and wait for it. */
  async exec(
    id: string,
    command: string,
    opts: { cwd?: string; timeout?: number } = {},
  ) {
    const r = await this.call<{ exitCode: number; result: string }>(
      `${await this.tb(id)}/process/execute`,
      {
        method: "POST",
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
  async startAsync(id: string, sessionId: string, command: string) {
    const base = await this.tb(id);
    await fetch(`${base}/process/session`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ sessionId }),
    });
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
  ) {
    const form = new FormData();
    form.append("file", new Blob([content]), path.split("/").pop());
    const res = await fetch(
      `${await this.tb(id)}/files/upload?path=${encodeURIComponent(path)}`,
      {
        method: "POST",
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
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
