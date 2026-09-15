import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const dist = path.join(root, "dist");
const server = path.join(dist, "server");
const files = {};
for (const entry of fs.readdirSync(dist, { withFileTypes: true })) {
  if (!entry.isFile()) continue;
  files[`/${entry.name}`] = fs.readFileSync(path.join(dist, entry.name)).toString("base64");
}
fs.mkdirSync(server, { recursive: true });
fs.writeFileSync(path.join(server, "assets.mjs"), `export default ${JSON.stringify(files)};\n`);
fs.copyFileSync(path.join(root, "worker", "index.mjs"), path.join(server, "index.js"));
fs.mkdirSync(path.join(dist, ".openai"), { recursive: true });
fs.copyFileSync(path.join(root, ".openai", "hosting.json"), path.join(dist, ".openai", "hosting.json"));
