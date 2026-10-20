import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildTokensCss } from "../src/lib/tokens/build";

const root = resolve(__dirname, "..");
const tokens = JSON.parse(readFileSync(resolve(root, "tokens/tokens.json"), "utf8"));
const css = buildTokensCss(tokens);
writeFileSync(resolve(root, "src/styles/tokens.css"), css);
console.log("Wrote src/styles/tokens.css");
