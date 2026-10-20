/**
 * Converts tokens/tokens.json into CSS custom properties.
 * Pure function so it can be unit-tested and used by scripts/build-tokens.ts.
 */

type TokenLeaf = { $type: string; $value: string };
type TokenTree = { [key: string]: TokenTree | TokenLeaf | string };

function isLeaf(node: unknown): node is TokenLeaf {
  return typeof node === "object" && node !== null && "$value" in node;
}

/** Flattens a token tree into ["color.neutral.0", leaf] pairs, skipping $-prefixed metadata keys. */
export function flattenTokens(tree: TokenTree, prefix: string[] = []): Array<[string, TokenLeaf]> {
  const out: Array<[string, TokenLeaf]> = [];
  for (const [key, node] of Object.entries(tree)) {
    if (key.startsWith("$")) continue;
    const path = [...prefix, key];
    if (isLeaf(node)) out.push([path.join("."), node]);
    else if (typeof node === "object" && node !== null) out.push(...flattenTokens(node as TokenTree, path));
  }
  return out;
}

export function cssVarName(path: string): string {
  return `--nx-${path.replace(/\./g, "-")}`;
}

/** Replaces {color.neutral.0} references with var(--nx-color-neutral-0). */
export function resolveValue(value: string): string {
  return value.replace(/\{([^}]+)\}/g, (_, ref: string) => `var(${cssVarName(ref)})`);
}

export function buildTokensCss(tokens: TokenTree): string {
  const all = flattenTokens(tokens);
  const base = all.filter(([path]) => !path.startsWith("semantic."));
  const light = all.filter(([path]) => path.startsWith("semantic.light."));
  const dark = all.filter(([path]) => path.startsWith("semantic.dark."));

  const line = (name: string, value: string) => `  ${name}: ${resolveValue(value)};`;
  const semanticName = (path: string) => cssVarName(path.split(".").slice(2).join("."));

  return [
    "/* Generated from tokens/tokens.json by `npm run tokens:build`. Do not edit by hand. */",
    "",
    ":root {",
    ...base.map(([path, leaf]) => line(cssVarName(path), leaf.$value)),
    ...light.map(([path, leaf]) => line(semanticName(path), leaf.$value)),
    "}",
    "",
    ".dark {",
    ...dark.map(([path, leaf]) => line(semanticName(path), leaf.$value)),
    "}",
    "",
  ].join("\n");
}
