export interface Env {
  RUNS: DurableObjectNamespace;
  DAYTONA_API_URL: string;
  DAYTONA_TARGET: string;
  DAYTONA_API_KEY: string;
  DAYTONA_SNAPSHOT?: string;
  OPENAI_API_KEY: string;
  ORCHESTRATOR_MODEL: string;
  VERIFIER_MODEL?: string;
  WORKER_MODEL: string;
  MAX_WORKERS: string;
  SPECTRON_URL?: string;
  SPECTRON_CONTEXT_ID?: string;
  SPECTRON_API_KEY?: string;
  ANCHORBROWSER_API_KEY?: string;
  EVENTS_WEBHOOK_URL?: string;
  ARIZE_API_KEY?: string;
  ARIZE_SPACE_ID?: string;
  GATEWAY_TOKEN?: string; // the run sandbox's token for /gateway/*
  OPERATOR_TOKEN?: string; // the backend's token for /sandboxes/*
  // The `reversy` Worker's Records entrypoint: writes run records to SurrealDB (service binding, not public).
  RECORDS?: { record(input: RunRecord): Promise<void> };
}

export interface RunRecord {
  run: { id: string; url: string; goal: string; startedAt: string };
  event: RunEvent;
}

export type Phase =
  | "brief"
  | "inspecting"
  | "planning"
  | "planned"
  | "building"
  | "variants"
  | "done"
  | "stopped"
  | "failed";

export type EvidenceStatus = "observed" | "inferred" | "not_observed";

export interface Evidence {
  id: string; // ev_001
  page: string; // URL path
  kind:
    | "screenshot"
    | "html"
    | "markdown"
    | "styles"
    | "assets"
    | "links"
    | "network";
  tool: "anchor" | "fetch" | "llm";
  status: EvidenceStatus;
  capturedAt: string;
  hash: string;
  limits: string;
  summary: string;
  path?: string; // where it lives in the sandbox evidence store
  url?: string; // where the UI can load it (screenshots)
}

export interface Spec {
  url: string;
  goal: string;
  pages: { path: string; confirmed: boolean; notes?: string }[];
  flows: { name: string; confirmed: boolean; notes?: string }[];
  openQuestions: string[];
  approved: boolean;
  revision: number;
}

export type TaskStatus =
  | "queued"
  | "building"
  | "in_review"
  | "merged"
  | "failed"
  | "stopped";

export interface Task {
  id: string; // t01
  title: string;
  brief: string;
  outOfScope: string;
  acceptance: string[];
  evidence: string[];
  owns: string[];
  dependsOn: string[];
  status: TaskStatus;
  attempts: number;
  branch: string;
  cmdId?: string;
  startedAt?: string;
  finishedAt?: string;
  review?: {
    verdict: "approve" | "reject";
    reason: string;
    findings: string[];
  };
  diffStat?: string;
  failure?: string;
  verification?: boolean;
  nextAction?: string;
  variant?: string; // the variant pod it builds in; none means the run's main rebuild
  fixFor?: string; // the merged task whose verifier failure it fixes
}

// A landing-page alternative built in its own pod from a snapshot of the merged rebuild.
export interface Variant {
  id: string; // v1
  title: string;
  change: string;
  explanation: string;
  pod: "fork" | "copy"; // Daytona fork when the account allows it, otherwise a copy in the run sandbox
  sandboxId: string;
  dir: string; // its repo inside that sandbox
  snapshot: string; // the main commit it started from
  status: "building" | "ready" | "failed" | "promoted";
}

export interface RunEvent {
  seq: number;
  ts: string;
  type:
    | "chat"
    | "spec"
    | "evidence"
    | "plan"
    | "task"
    | "review"
    | "preview"
    | "phase"
    | "verification"
    | "variant"
    | "error";
  data: unknown;
}

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  ts: string;
}
