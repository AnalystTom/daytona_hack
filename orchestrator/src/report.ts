// Text preparation and goal detection for report-dissection runs.
export function articleText(html: string, max = 20000) {
  const out: string[] = [];
  for (const m of html.matchAll(
    /<(h1|h2|h3|h4|p|li|figcaption|td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi,
  )) {
    const t = m[2]
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&#39;|&rsquo;/g, "'")
      .replace(/\s+/g, " ")
      .trim();
    if (t.length > 25 || /\d/.test(t))
      out.push(m[1].toLowerCase().startsWith("h") ? `## ${t}` : t);
  }
  return out.join("\n").slice(0, max);
}

export const isReportGoal = (goal: string) =>
  /\b(?:reconstruct|dissect|rebuild)\s+(?:(?:this|that|the|a|an)\s+)?(?:(?:financial|investment)\s+)?reports?\b/i.test(goal);
