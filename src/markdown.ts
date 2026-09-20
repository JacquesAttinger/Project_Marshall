// Last edited: 2026-09-20 15:20 CDT
// Markdown section helpers shared by the plan check and the hand-off check. Pure text functions:
// H2 headings in order, the TLDR paragraph, a section's body, and the required-sections rule.

/** Lower-case, trimmed, trailing `.`/`:` dropped, inner whitespace collapsed. */
export function normalizeHeading(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[.:]+$/, "")
    .replace(/\s+/g, " ");
}

/** H2 titles in file order, untouched. */
export function headings(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m?.[1]) out.push(m[1]);
  }
  return out;
}

/** A `**TLDR:**` paragraph before the first H2 counts as the TLDR section. */
export function hasTldrParagraph(text: string): boolean {
  for (const line of text.split("\n")) {
    if (/^##\s/.test(line)) return false;
    if (/^\*\*TLDR:?\*\*:?/i.test(line.trim())) return true;
  }
  return false;
}

/** Body of `## <heading>` up to the next H2, trimmed. Null when the section is absent. */
export function sectionBody(text: string, heading: string): string | null {
  const lines = text.split("\n");
  const want = normalizeHeading(heading);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = /^##\s+(.+?)\s*$/.exec(lines[i] as string);
    if (!m?.[1]) continue;
    if (start >= 0) return lines.slice(start, i).join("\n").trim();
    if (normalizeHeading(m[1]) === want) start = i + 1;
  }
  return start >= 0 ? lines.slice(start).join("\n").trim() : null;
}

/** The TLDR paragraph (the `**TLDR:**` block, or the `## TLDR` body), or null. */
export function tldrOf(text: string): string | null {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] as string).trim();
    if (/^##\s/.test(line)) break;
    if (!/^\*\*TLDR:?\*\*:?/i.test(line)) continue;
    const block: string[] = [];
    for (let j = i; j < lines.length && (lines[j] as string).trim().length > 0; j++) {
      block.push((lines[j] as string).trim());
    }
    return block.join("\n");
  }
  return sectionBody(text, "TLDR");
}

export interface SectionCheck {
  missing: string[];
  /** Required sections that appear before one that should precede them. */
  misordered: string[];
}

/**
 * Every heading in `required` must be present, in that relative order. Extra headings are fine.
 * `TLDR` (when required) is also satisfied by a `**TLDR:**` paragraph under the H1.
 */
export function checkRequiredSections(text: string, required: readonly string[]): SectionCheck {
  const found = headings(text).map(normalizeHeading);
  if (hasTldrParagraph(text)) found.unshift("tldr");
  const missing: string[] = [];
  const misordered: string[] = [];
  let furthest = -1;
  for (const section of required) {
    const at = found.indexOf(normalizeHeading(section));
    if (at < 0) {
      missing.push(section);
      continue;
    }
    if (at < furthest) misordered.push(section);
    furthest = Math.max(furthest, at);
  }
  return { missing, misordered };
}
