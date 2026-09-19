import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..");
const enricher = resolve(projectRoot, "scripts/semantic_enrichment.py");
const suppliedArgs = Bun.argv.slice(2);
const inputIndex = suppliedArgs.findIndex((value) => value.endsWith(".semantic-baseline.json"));

if (inputIndex === -1) {
  console.error("请传入 semantic baseline JSON，例如：bun run enrich reports/semantic/example.semantic-baseline.json");
  process.exit(2);
}

const input = resolve(process.cwd(), suppliedArgs[inputIndex]!);
const forwardedArgs = suppliedArgs.toSpliced(inputIndex, 1);
const processHandle = Bun.spawn(["uv", "run", enricher, input, ...forwardedArgs], {
  cwd: projectRoot,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

process.exit(await processHandle.exited);
