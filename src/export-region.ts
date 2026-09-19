import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..");
const exporter = resolve(projectRoot, "scripts/dxf_export.py");

async function defaultDxf(): Promise<string> {
  const dataDirectory = resolve(projectRoot, "data");
  const entries = await readdir(dataDirectory, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".dxf"))
    .map((entry) => resolve(dataDirectory, entry.name))
    .sort();

  if (candidates.length === 0) throw new Error(`没有在 ${dataDirectory} 中找到 DXF 文件。`);
  if (candidates.length > 1) throw new Error("data 中存在多个 DXF 文件，请显式传入 DXF 路径。");
  return candidates[0]!;
}

const suppliedArgs = Bun.argv.slice(2);
const inputIndex = suppliedArgs.findIndex((value) => value.toLowerCase().endsWith(".dxf"));
const input = inputIndex === -1 ? await defaultDxf() : resolve(process.cwd(), suppliedArgs[inputIndex]!);
const forwardedArgs = inputIndex === -1 ? suppliedArgs : suppliedArgs.toSpliced(inputIndex, 1);

const processHandle = Bun.spawn(["uv", "run", exporter, input, ...forwardedArgs], {
  cwd: projectRoot,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

process.exit(await processHandle.exited);
