// The brief Entry A carries into the workspace chat, and the starter prompts that pre-fill it.

export type Brief = { text: string; files: File[] };

export type StarterId =
  | "daytona"
  | "landing-page"
  | "interaction"
  | "screenshots"
  | "inspect";

export type Starter = {
  id: StarterId;
  title: string;
  hint: string;
  draft: string;
};

export const starters: Record<StarterId, Starter> = {
  daytona: {
    id: "daytona",
    title: "Rebuild Daytona's landing page",
    hint: "https://www.daytona.io/",
    draft: "Rebuild Daytona's landing page at https://www.daytona.io/",
  },
  "landing-page": {
    id: "landing-page",
    title: "Rebuild a landing page",
    hint: "Add the URL of the page",
    draft: "Rebuild the landing page at ",
  },
  interaction: {
    id: "interaction",
    title: "Recreate one interaction",
    hint: "Add a URL and describe the behavior",
    draft: "Recreate one interaction from ",
  },
  screenshots: {
    id: "screenshots",
    title: "Work from screenshots",
    hint: "Attach the screens you want to recreate",
    draft: "Rebuild the screens in the attached screenshots. ",
  },
  inspect: {
    id: "inspect",
    title: "Inspect a website",
    hint: "Add a URL to map its pages and flows",
    draft: "Map the pages and interactions of ",
  },
};

// Drafts live in memory and the /start history entry holds only their id under `draft`: Chrome drops
// history state that contains Files when the user goes back, and attachments must never be asked for twice.
const briefs = new Map<string, Brief>();

/** Keeps a brief for the session and returns the history state that refers to it. */
export function keepBrief(brief: Brief) {
  const id = crypto.randomUUID();
  briefs.set(id, brief);
  return { draft: id };
}

/** The brief a history entry's state refers to, or null (fresh entry, reload or foreign state). */
export function readBrief(historyState: unknown): Brief | null {
  const id = (historyState as { draft?: unknown } | null)?.draft;
  return (typeof id === "string" && briefs.get(id)) || null;
}

/** The draft Entry A opens with: the one kept on this history entry, else the `?starter=` prompt, else empty. */
export function initialBrief(historyState: unknown, search: string): Brief {
  const kept = readBrief(historyState);
  if (kept) return kept;
  const id = new URLSearchParams(search).get("starter");
  const starter =
    id && Object.hasOwn(starters, id) ? starters[id as StarterId] : undefined;
  return { text: starter?.draft ?? "", files: [] };
}

export function canSend(brief: Brief) {
  return brief.text.trim() !== "" || brief.files.length > 0;
}

/** Adds files, skipping ones already attached so nothing is uploaded twice. */
export function addFiles(current: File[], incoming: Iterable<File>) {
  const key = (file: File) => `${file.name}:${file.size}:${file.lastModified}`;
  const seen = new Set(current.map(key));
  const added = [...incoming].filter((file) => {
    if (seen.has(key(file))) return false;
    seen.add(key(file));
    return true;
  });
  return [...current, ...added];
}
