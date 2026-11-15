#!/usr/bin/env node
// Configura la identidad del monitor: usuario y repositorio de GitHub.
//
//   node scripts/configure-owner.mjs <owner> <repo>
//
// Deja el Worker apuntando al repo correcto y falla si queda alguna referencia
// al owner del upstream original.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const wranglerPath = path.join(here, "..", "wrangler.jsonc");

const [, , owner, repo] = process.argv;
if (!owner || !repo) {
  console.error("Uso: node scripts/configure-owner.mjs <owner> <repo>");
  process.exit(1);
}
if (!/^[A-Za-z0-9-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo)) {
  console.error("owner/repo inválido.");
  process.exit(1);
}

let content = await readFile(wranglerPath, "utf8");

content = content.replace(
  /("GITHUB_OWNER"\s*:\s*)"[^"]*"/,
  `$1"${owner}"`,
);
content = content.replace(
  /("GITHUB_REPO"\s*:\s*)"[^"]*"/,
  `$1"${repo}"`,
);

if (!content.includes(`"${owner}"`) || !content.includes(`"${repo}"`)) {
  console.error("No se pudo actualizar wrangler.jsonc.");
  process.exit(1);
}

await writeFile(wranglerPath, content, "utf8");
console.log(`✔ wrangler.jsonc configurado para ${owner}/${repo}`);
console.log("  Recordá: wrangler secret put GITHUB_TOKEN");
