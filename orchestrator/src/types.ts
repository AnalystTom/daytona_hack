import type { EvidenceRecord } from "../../src/shared/evidence";
import type { StoreEnv } from "../../src/worker/store";

// SURREALDB_* (StoreEnv) hold evidence records and files.
export interface Env extends StoreEnv {
  RUNS: DurableObjectNamespace;
  SURREALDB_URL?: string;
  SURREALDB_NAMESPACE?: string;
  SURREALDB_DATABASE?: string;
  SURREALDB_USER?: string;
  SURREALDB_PASSWORD?: string;
  DAYTONA_API_URL: string;
  DAYTONA_TARGET: string;
  DAYTONA_API_KEY: string;
  DAYTONA_SNAPSHOT?: string;
  OPENAI_API_KEY: string;
  ORCHESTRATOR_MODEL: string;
  VERIFIER_MODEL?: string;
  WORKER_MODEL: string;
  WORKER_EFFORT?: string;
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
}

export type Phase =
  | "brief"
  | "inspecting"
  | "awaiting_sign_in" // a page left the scope (usually to sign in): user signs in or skips
  | "planning"
  | "planned"
  | "building"
  | "done"
  | "stopped"
  | "failed";

export type EvidenceStatus = "observed" | "inferred" | "not_observed";

export interface Evidence {
  id: string;
  page: string; // URL path and state, e.g. "/ @ desktop 1440"
  kind: EvidenceRecord["kind"] | "html";
  tool: string;
  status: EvidenceStatus;
  capturedAt: string;
  hash: string;
  limits: string;
  summary: string;
  path?: string; // where it lives in the sandbox evidence store
  url?: string; // where the UI can load it (screenshots and recordings)
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
  nextAction?: string;
}

export interface RunEvent {
  seq: number;
  ts: string;
  type:
    | "report"
    | "chat"
    | "spec"
    | "evidence"
    | "plan"
    | "task"
    | "review"
    | "preview"
    | "phase"
    | "verification"
    | "error";
  data: unknown;
}

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  ts: string;
}
