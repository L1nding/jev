import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

type CadEntity = {
  id: string;
  source: {
    handle: string;
    entity_type: string;
    layer: string;
    block?: { name: string; expanded: boolean };
  };
  anchor: { local: number[] | null };
  bbox: { local: number[] | null };
  geometry: { local: Record<string, unknown> | null };
  text?: string;
};

type CadIr = {
  schema_version: string;
  source: { path: string; sha256: string; units: { name: string } };
  selection: { region_id: string };
  entities: CadEntity[];
};

type AnalysisWindows = {
  schema_version: string;
  region: { id: string };
  windows: Array<{
    id: string;
    owned_entity_ids: string[];
    context_entity_ids: string[];
  }>;
};

type DecisionsResponse = {
  id?: string;
  model?: string;
  provider?: string;
  usage?: Record<string, unknown>;
  answers?: Record<string, { type?: string; choice?: string; confidence?: number; probabilities?: Record<string, number> }>;
  error?: { message?: string };
};

const OPENROUTER_URL = "https://openrouter.ai/api/alpha/decisions";
const MODEL = Bun.env.OPENROUTER_MODEL ?? "typesafe/jev-1.13";
const apiKey = Bun.env.OPENROUTER_API_KEY;

const criteria = {
  wall: "A wall, partition, wall segment, or member of a wall assembly.",
  door: "A door, door leaf, door opening, or door hardware symbol.",
  window: "A window, glazed opening, or window frame symbol.",
  column: "A structural column, pier, or column representation.",
  stair: "A stair, elevator, ramp, or vertical circulation element.",
  furniture: "Furniture, equipment, fixture, or movable interior object.",
  annotation: "Text, dimensions, axes, hatches, or drafting notation rather than building geometry.",
  unknown: "The supplied evidence is insufficient to choose another type.",
};

function usage(): never {
  console.error(`用法：
  bun run jev <cad-ir.json> [--limit 32] [--batch-size 8] [--layers WALL,WINDOW,PL-DOOR,COLUMN]
  bun run jev <cad-ir.json> --windows <analysis-windows.json> --window <window-id> --all [--include-context]

默认只发送前 32 个实体作为试运行；使用 --all 才会发送整个 CAD IR。`);
  process.exit(2);
}

function parseNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs() {
  const args = Bun.argv.slice(2);
  const inputIndex = args.findIndex((value) => value.endsWith(".cad-ir.json"));
  if (inputIndex === -1) usage();

  const input = resolve(process.cwd(), args[inputIndex]!);
  const valueAfter = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const all = args.includes("--all");
  const limit = all ? Number.POSITIVE_INFINITY : parseNumber(valueAfter("--limit"), 32);
  const batchSize = Math.min(32, parseNumber(valueAfter("--batch-size"), 8));
  const layers = (valueAfter("--layers") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const windows = valueAfter("--windows");
  const windowId = valueAfter("--window");
  if ((windows && !windowId) || (!windows && windowId)) {
    console.error("--windows 和 --window 必须同时提供。");
    process.exit(2);
  }
  const includeContext = args.includes("--include-context");
  const outputDir = resolve(process.cwd(), valueAfter("--output-dir") ?? "reports/jev");
  return { input, limit, batchSize, layers, windows: windows ? resolve(process.cwd(), windows) : null, windowId, includeContext, outputDir };
}

function selectEntities(entities: CadEntity[], limit: number, layers: string[], allowedIds: Set<string> | null): CadEntity[] {
  const eligible = allowedIds ? entities.filter((entity) => allowedIds.has(entity.id)) : entities;
  if (layers.length === 0) return eligible.slice(0, Number.isFinite(limit) ? limit : undefined);
  const buckets = layers.map((layer) => eligible.filter((entity) => entity.source.layer === layer));
  const selected: CadEntity[] = [];
  for (let index = 0; selected.length < limit; index += 1) {
    let added = false;
    for (const bucket of buckets) {
      const entity = bucket[index];
      if (entity && selected.length < limit) {
        selected.push(entity);
        added = true;
      }
    }
    if (!added) break;
  }
  return selected;
}

function keyFor(entity: CadEntity): string {
  return `e_${createHash("sha1").update(entity.id).digest("hex").slice(0, 12)}`;
}

function compactEntity(entity: CadEntity, key: string) {
  return {
    key,
    source_id: entity.id,
    handle: entity.source.handle,
    entity_type: entity.source.entity_type,
    layer: entity.source.layer,
    block_name: entity.source.block?.name ?? null,
    text: entity.text ?? null,
    anchor_local: entity.anchor.local,
    bbox_local: entity.bbox.local,
    geometry: entity.geometry.local,
  };
}

function question(key: string) {
  return {
    type: "choice",
    instructions: `根据 state.entities 中 key=${key} 的 CAD 证据，判断该实体的建筑语义类型。只选择最符合证据的一个类型；证据不足时选择 unknown。`,
    criteria,
  };
}

async function request(batch: CadEntity[]) {
  const entities = Object.fromEntries(batch.map((entity) => [keyFor(entity), compactEntity(entity, keyFor(entity))]));
  const questions = Object.fromEntries(Object.keys(entities).map((key) => [key, question(key)]));
  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(Bun.env.OPENROUTER_SITE_URL ? { "HTTP-Referer": Bun.env.OPENROUTER_SITE_URL } : {}),
      ...(Bun.env.OPENROUTER_APP_NAME ? { "X-OpenRouter-Title": Bun.env.OPENROUTER_APP_NAME } : {}),
    },
    body: JSON.stringify({ model: MODEL, state: { entities }, questions }),
  });
  const body = (await response.json()) as DecisionsResponse;
  if (!response.ok) {
    throw new Error(`OpenRouter 请求失败 (${response.status}): ${body.error?.message ?? JSON.stringify(body)}`);
  }
  return { body, entities };
}

const { input, limit, batchSize, layers, windows, windowId, includeContext, outputDir } = parseArgs();
if (!apiKey) {
  console.error("缺少 OPENROUTER_API_KEY，请配置 .env。");
  process.exit(1);
}

const cadIr = JSON.parse(await readFile(input, "utf8")) as CadIr;
if (cadIr.schema_version !== "cad-ir-v1") {
  console.error("输入必须是 cad-ir-v1 CAD IR JSON。");
  process.exit(2);
}

let allowedIds: Set<string> | null = null;
if (windows && windowId) {
  const manifest = JSON.parse(await readFile(windows, "utf8")) as AnalysisWindows;
  if (manifest.schema_version !== "analysis-windows-v1") {
    console.error("--windows 输入必须是 analysis-windows-v1 JSON。");
    process.exit(2);
  }
  const selectedWindow = manifest.windows.find((window) => window.id === windowId);
  if (!selectedWindow) {
    console.error(`找不到 Analysis Window：${windowId}`);
    process.exit(2);
  }
  allowedIds = new Set([
    ...selectedWindow.owned_entity_ids,
    ...(includeContext ? selectedWindow.context_entity_ids : []),
  ]);
}

const selected = selectEntities(cadIr.entities, limit, layers, allowedIds);
const decisions: Array<Record<string, unknown>> = [];
const batches: Array<Record<string, unknown>> = [];

for (let index = 0; index < selected.length; index += batchSize) {
  const batch = selected.slice(index, index + batchSize);
  const { body, entities } = await request(batch);
  batches.push({ index: Math.floor(index / batchSize), entity_count: batch.length, request_id: body.id ?? null, model: body.model ?? MODEL, provider: body.provider ?? null, usage: body.usage ?? null });
  for (const [key, answer] of Object.entries(body.answers ?? {})) {
    const entity = entities[key];
    decisions.push({
      source_id: entity?.source_id ?? null,
      key,
      semantic_type: answer.choice ?? "unknown",
      confidence: answer.confidence ?? null,
      probabilities: answer.probabilities ?? {},
      model: body.model ?? MODEL,
      request_id: body.id ?? null,
    });
  }
  console.error(`Jev batch ${Math.floor(index / batchSize) + 1}/${Math.ceil(selected.length / batchSize)} 完成`);
}

const result = {
  schema_version: "jev-decisions-v1",
  generated_at: new Date().toISOString(),
  input: { cad_ir_path: input, cad_ir_sha256: createHash("sha256").update(await readFile(input)).digest("hex"), region_id: cadIr.selection.region_id, source_sha256: cadIr.source.sha256 },
  model: MODEL,
  endpoint: OPENROUTER_URL,
  selection: {
    requested_limit: Number.isFinite(limit) ? limit : "all",
    selected_entity_count: selected.length,
    batch_size: batchSize,
    layers,
    window_id: windowId ?? null,
    include_context: includeContext,
  },
  summary: {
    decision_count: decisions.length,
    batches: batches.length,
    missing_answers: selected.length - decisions.length,
    semantic_type_counts: decisions.reduce<Record<string, number>>((counts, decision) => {
      const semanticType = String(decision.semantic_type ?? "unknown");
      counts[semanticType] = (counts[semanticType] ?? 0) + 1;
      return counts;
    }, {}),
  },
  batches,
  decisions,
};

await mkdir(outputDir, { recursive: true });
const stem = basename(input).replace(/\.cad-ir\.json$/, "");
const output = resolve(outputDir, `${stem}.jev-decisions.json`);
await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ output, ...result.summary }, null, 2));
