// Last edited: 2026-09-20 16:05 CDT
// The hand-off file → the text posted to Linear and spliced into the PR body: the H1 and the
// `Last edited` stamp go, and an optional badge (`_rebased after …_`) lands right under the TLDR.
// The badge lives in the sidecar and in both posted copies, never in the .md file.

const LAST_EDITED = /^<!--\s*Last edited:.*-->\s*$/;
const H2 = /^##\s/;
const TLDR_PARAGRAPH = /^\*\*TLDR:?\*\*:?/i;
const TLDR_HEADING = /^##\s+TLDR\s*:?\s*$/i;

/** Index of the last line of the TLDR block (paragraph or `## TLDR` body), or -1. */
function tldrEnd(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] as string).trim();
    if (TLDR_PARAGRAPH.test(line)) {
      let end = i;
      while (end + 1 < lines.length && (lines[end + 1] as string).trim().length > 0) end++;
      return end;
    }
    if (H2.test(line)) break;
  }
  const at = lines.findIndex((l) => TLDR_HEADING.test(l.trim()));
  if (at < 0) return -1;
  let end = at;
  for (let i = at + 1; i < lines.length && !H2.test(lines[i] as string); i++) {
    if ((lines[i] as string).trim().length > 0) end = i;
  }
  return end;
}

export function renderPackage(fileText: string, opts: { badge?: string } = {}): string {
  const lines = fileText.replace(/\r\n/g, "\n").split("\n");
  const firstText = lines.findIndex((l) => l.trim().length > 0);
  if (firstText >= 0 && /^#\s/.test(lines[firstText] as string)) lines.splice(firstText, 1);
  const kept = lines.filter((l) => !LAST_EDITED.test(l));
  if (opts.badge) {
    const end = tldrEnd(kept);
    kept.splice(end + 1, 0, "", `_${opts.badge}_`);
  }
  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
