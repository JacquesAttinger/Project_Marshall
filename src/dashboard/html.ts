// Last edited: 2026-10-03 18:27 CDT
// The dashboard's only way to build HTML: an `html` tagged template that escapes every value by
// default, `raw()` for markup that is already safe, and the hand-off Markdown renderer, which
// turns agent-written text into inert HTML (no raw HTML, no images, only http(s) and # links).

/** Markup that is already safe to drop into the page as-is. */
export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c] as string);
}

/** Wrap trusted markup. Only for strings this module or a template produced. */
export function raw(value: string): SafeHtml {
  return new SafeHtml(value);
}

type Value = SafeHtml | string | number | boolean | null | undefined | Value[];

function render(value: Value): string {
  if (value === null || value === undefined || value === false || value === true) return "";
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(render).join("");
  return escapeHtml(String(value));
}

/**
 * `html\`<p>${title}</p>\`` escapes `title`. Arrays are joined, `null`/`undefined`/booleans render
 * as nothing (so `${cond && html\`…\`}` works), and nested `html` results pass through.
 */
export function html(strings: TemplateStringsArray, ...values: Value[]): SafeHtml {
  let out = strings[0] ?? "";
  for (let i = 0; i < values.length; i++) {
    out += render(values[i] as Value) + (strings[i + 1] ?? "");
  }
  return new SafeHtml(out);
}

const SAFE_HREF = /^(https?:|#)/i;

/** Drop raw HTML, images, and any link that is not http(s) or a fragment. */
const sanitizer = new HTMLRewriter()
  .on("a", {
    element(el) {
      const href = el.getAttribute("href") ?? "";
      if (!SAFE_HREF.test(href.trim())) {
        el.removeAttribute("href");
        return;
      }
      el.setAttribute("rel", "noopener noreferrer");
      el.setAttribute("target", "_blank");
    },
  })
  .on("img", {
    element(el) {
      el.remove();
    },
  });

/**
 * Agent-written Markdown → inert HTML. HTML comments go first (the `<!-- Last edited -->` header
 * would otherwise show as text), then raw HTML is rendered as text, then the rewriter strips what
 * the Markdown itself can still produce: images and `javascript:` style links.
 */
export function renderMarkdown(markdown: string): SafeHtml {
  const text = markdown.replace(/<!--[\s\S]*?-->/g, "");
  const out = Bun.markdown.html(text, { noHtmlBlocks: true, noHtmlSpans: true });
  return new SafeHtml(sanitizer.transform(out));
}
