import { z } from "zod";

export const GOLDMAN_URL =
  "https://www.goldmansachs.com/insights/articles/global-investment-is-forecast-to-exceed-1-trillion-in-2026";
export const GOLDMAN_GOAL =
  "Goldman Sachs demo: Reconstruct this report: rebuild its key figures and the investment breakdown as an editable page, link every number to where it appears in the source, and mark anything not observed. Search online for the original reports and datasets behind every figure. Fixed scope: this report dissection only. Approve this scope and its research plan automatically; no website rebuild, REA, variants, or build workers.";
export const GOLDMAN_BRIEF = `${GOLDMAN_URL}\n${GOLDMAN_GOAL}`;
export const isGoldmanDemo = (url: string, goal: string) =>
  url === GOLDMAN_URL && goal === GOLDMAN_GOAL;

export const ReportLocation = z.object({
  kind: z.enum(["html", "chart_data", "screenshot"]),
  start: z.int().nonnegative(),
  end: z.int().positive(),
  path: z.string().min(1),
  screenshot: z
    .object({
      evidenceId: z.string().min(1),
      x: z.number().nonnegative(),
      y: z.number().nonnegative(),
      width: z.number().positive(),
      height: z.number().positive(),
      pageWidth: z.number().positive(),
      pageHeight: z.number().positive(),
    })
    .optional(),
});
export const ReportFigure = z.object({
  id: z.string().min(1),
  value: z.string(),
  unit: z.string(),
  label: z.string().min(1),
  quote: z.string().min(1),
  sourceId: z.string().min(1),
  location: ReportLocation,
  status: z.enum(["observed", "inferred", "not_observed"]),
  reason: z.string(),
  group: z.enum(["key_figures", "investment_breakdown", "not_observed"]),
});
export type ReportFigure = z.infer<typeof ReportFigure>;

const currencyCodes = "USD|CAD|AUD|NZD|HKD|SGD|GBP|EUR|JPY|CNY|CHF|INR";
const currencyToken = new RegExp(`^(?:${currencyCodes})$`, "i");
const scaleToken =
  /^(?:%|trillion|billion|million|thousand|bn|bps|[kmbt]|dollars|pounds|euros)$/i;
const scalar = new RegExp(
  `^(?:(?<prefix>${currencyCodes})\\s*)?(?<sign>[+−–-]?)(?:\\s*(?<symbol>[$€£])\\s*(?<innerSign>[+−–-]?))?\\s*(?:(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?|\\.\\d+)\\s*(?<scale>%|trillion|billion|million|thousand|bn|bps)?(?:\\s*(?<suffix>${currencyCodes}))?$`,
  "i",
);
const currencyContext = (token: string) => {
  const word = token.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "");
  return (
    currencyToken.test(word) ||
    /^[A-Z]{3}$/.test(word) ||
    /^[\p{P}\p{S}]+$/u.test(token) ||
    /^[\p{P}\p{S}]+[A-Za-z]{3}[\p{P}\p{S}]*$/u.test(token)
  );
};

export function reportQuantities(quote: string) {
  const tokens = [...quote.matchAll(/\S+/gu)];
  const quantities: {
    value: string;
    unit: string;
    currency: string;
    status: "observed" | "not_observed";
  }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!/\d/.test(tokens[i]![0])) continue;
    let first = i;
    while (first > 0 && currencyContext(tokens[first - 1]![0])) first--;
    let last = i;
    while (last + 1 < tokens.length) {
      const next = tokens[last + 1]![0];
      const word = next.replace(/[.,;:!?)]+$/, "");
      if (
        /^[+−–—\p{Sc}]*\.?\d/u.test(next) ||
        scaleToken.test(word) ||
        currencyContext(word)
      )
        last++;
      else if (
        /^[\p{P}\p{S}]+$/u.test(next) &&
        /\d/.test(tokens[last + 2]?.[0] ?? "")
      )
        last += 2;
      else break;
    }
    const end = tokens[last]!;
    const value = quote
      .slice(tokens[first]!.index, end.index + end[0].length)
      .replace(/[.,;:!?]+$/, "");
    const parsed = scalar.exec(value)?.groups;
    const prefix = parsed?.prefix?.toUpperCase();
    const suffix = parsed?.suffix?.toUpperCase();
    const symbol = parsed?.symbol;
    const currency = prefix ?? suffix ?? (symbol === "€" ? "EUR" : "");
    const observed =
      !!parsed &&
      !(parsed.sign && parsed.innerSign) &&
      !(prefix && suffix && prefix !== suffix) &&
      (!symbol ||
        !currency ||
        (symbol === "€"
          ? currency === "EUR"
          : symbol === "£"
            ? currency === "GBP"
            : /^(USD|CAD|AUD|NZD|HKD|SGD)$/.test(currency)));
    const unit = [symbol ?? prefix ?? suffix, parsed?.scale ?? "number"]
      .filter(Boolean)
      .join(" ");
    quantities.push({
      value: observed ? value : "",
      unit: observed ? unit : "",
      currency:
        observed && !/^(%|bps)$/i.test(parsed?.scale ?? "") ? currency : "",
      status: observed ? "observed" : "not_observed",
    });
    i = last;
  }
  return quantities;
}

export function exactQuoteEvidence(
  figure: ReportFigure,
  trace: { value: string; quote: string; completePassage?: boolean },
) {
  const text = (s: string) => s.replace(/\s+/g, " ").trim();
  const value = text(figure.value);
  if (
    !trace.completePassage ||
    figure.status !== "observed" ||
    !value ||
    text(trace.value) !== value ||
    text(trace.quote) !== text(figure.quote)
  )
    return false;
  const evidence = (quote: string) => {
    const passage = text(quote);
    const tail = passage.slice(passage.lastIndexOf(value) + value.length);
    if (!/^[.!?]*$/.test(tail)) return [];
    return reportQuantities(passage).filter(
      (quantity) =>
        quantity.status === "observed" &&
        !!quantity.currency &&
        quantity.value === value &&
        quantity.unit === figure.unit &&
        !/[-−–]/.test(quantity.value),
    );
  };
  const article = evidence(figure.quote);
  const source = evidence(trace.quote);
  return (
    article.length === 1 &&
    source.length === 1 &&
    article[0]!.currency === source[0]!.currency
  );
}
export const ReportSource = z.object({
  id: z.string().min(1),
  url: z.url({ protocol: /^https?$/ }).nullable(),
  title: z.string().min(1),
  publisher: z.string(),
  published: z.string(),
  quote: z.string().min(1),
  quoteUrl: z.url({ protocol: /^https?$/ }),
  capturedAt: z.iso.datetime(),
  hash: z.string(),
  status: z.enum([
    "in_article",
    "traced_online",
    "named_not_found",
    "not_observed",
  ]),
  reason: z.string(),
});
export const ReportTrace = z.object({
  figureId: z.string().min(1),
  sourceId: z.string().nullable(),
  status: z.enum(["matches", "differs", "not_found"]),
  value: z.string(),
  quote: z.string(),
  completePassage: z.boolean().optional(),
  reason: z.string(),
});
export const ReportEdit = z.object({
  label: z.string().trim().min(1).max(1000),
  value: z.string().trim().max(200),
});
export const ReportDissection = z
  .object({
    runId: z.string().min(1),
    title: z.string().min(1),
    completedAt: z.iso.datetime(),
    figures: z.array(ReportFigure),
    sources: z.array(ReportSource),
    traces: z.array(ReportTrace),
    edits: z.record(z.string(), ReportEdit),
    search: z.object({
      calls: z.int().nonnegative(),
      budget: z.int().positive(),
      limitations: z.string(),
    }),
    storage: z.object({
      table: z.literal("report_run"),
      recordId: z.string().min(1),
    }),
    replay: z
      .object({
        runId: z.string().min(1),
        completedAt: z.iso.datetime(),
        reason: z.string(),
      })
      .optional(),
  })
  .superRefine((report, ctx) => {
    const sources = new Set(report.sources.map((s) => s.id));
    const figures = new Set(report.figures.map((f) => f.id));
    if (
      figures.size !== report.figures.length ||
      sources.size !== report.sources.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Duplicate figure or source id",
      });
    if (
      report.storage.recordId !== report.runId ||
      report.search.calls > report.search.budget
    )
      ctx.addIssue({
        code: "custom",
        message: "Invalid report record or search budget",
      });
    for (const source of report.sources) {
      if (
        (source.status === "in_article" || source.status === "traced_online") &&
        (!source.url || !source.hash)
      )
        ctx.addIssue({
          code: "custom",
          message: `Missing captured source identity for ${source.id}`,
        });
    }
    for (const f of report.figures) {
      if (
        !sources.has(f.sourceId) ||
        f.location.end <= f.location.start ||
        (f.status === "observed" && !f.value)
      )
        ctx.addIssue({
          code: "custom",
          message: `Invalid provenance for ${f.id}`,
        });
    }
    for (const t of report.traces) {
      if (
        !figures.has(t.figureId) ||
        (t.sourceId !== null && !sources.has(t.sourceId)) ||
        (t.status !== "not_found" && (!t.sourceId || !t.quote || !t.value))
      )
        ctx.addIssue({ code: "custom", message: "Invalid source trace" });
    }
  });
export type ReportDissection = z.infer<typeof ReportDissection>;
