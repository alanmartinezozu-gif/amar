export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Tagged template that escapes interpolations unless they're wrapped with raw(). */
export class RawHtml {
  constructor(readonly html: string) {}
  toString(): string {
    return this.html;
  }
}

export function raw(html: string): RawHtml {
  return new RawHtml(html);
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): RawHtml {
  let out = strings[0];
  values.forEach((v, i) => {
    out += renderValue(v) + strings[i + 1];
  });
  return new RawHtml(out);
}

function renderValue(v: unknown): string {
  if (v instanceof RawHtml) return v.html;
  if (Array.isArray(v)) return v.map(renderValue).join("");
  if (v === null || v === undefined || v === false) return "";
  return escapeHtml(v);
}
