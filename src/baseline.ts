import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..");
const baseline = resolve(projectRoot, "scripts/semantic_baseline.py");
const suppliedArgs = Bun.argv.slice(2);
const inputIndex = suppliedArgs.findIndex((value) => value.endsWith(".cad-ir.json"));

if (inputIndex === -1) {
  console.error("请传入 CAD IR JSON，例如：bun run baseline reports/cad-ir/example.cad-ir.json");
  process.exit(2);
}

const input = resolve(process.cwd(), suppliedArgs[inputIndex]!);
const forwardedArgs = suppliedArgs.toSpliced(inputIndex, 1);
const processHandle = Bun.spawn(["uv", "run", baseline, input, ...forwardedArgs], {
  cwd: projectRoot,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

process.exit(await processHandle.exited);
