import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { validateRoomBoundary } from "./room-boundary";

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
  source: { sha256: string; units: { name: string } };
  selection: { region_id: string };
  entities: CadEntity[];
};

type EntityDecision = {
  source_id: string;
  semantic_type: string;
  confidence: number | null;
};

type JevDecisions = {
  schema_version: string;
  model: string;
  selection?: { window_id?: string | null };
  decisions: EntityDecision[];
};

type Answer = {
  choice?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
};

type DecisionsResponse = {
  id?: string;
  model?: string;
  provider?: string;
  usage?: Record<string, unknown>;
  answers?: Record<string, Answer>;
  error?: { message?: string };
};

type Mode = "element" | "room";

const OPENROUTER_URL = "https://openrouter.ai/api/alpha/decisions";
const MODEL = Bun.env.OPENROUTER_MODEL ?? "typesafe/jev-1.13";
const apiKey = Bun.env.OPENROUTER_API_KEY;

function usage(): never {
  console.error(`用法：
  bun run jev-object <cad-ir.json> <jev-decisions.json> --seed <source:id> --mode element [--radius 1500] [--limit 32]
  bun run jev-object <cad-ir.json> <jev-decisions.json> --seed <room-label-source:id> --mode room [--radius 4500] [--limit 64]

element 模式让 Jev 判断附近同类型图元是否属于同一个建筑对象。
room 模式把文字图元作为房间种子，让 Jev 判断附近图元相对该房间的角色。`);
  process.exit(2);
}

function parsePositive(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs() {
  const args = Bun.argv.slice(2);
  const jsonArgs = args.filter((value) => value.endsWith(".json"));
  if (jsonArgs.length < 2) usage();
  const valueAfter = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const mode = (valueAfter("--mode") ?? "element") as Mode;
  const seed = valueAfter("--seed");
  if (!seed || !["element", "room"].includes(mode)) usage();
  return {
    cadPath: resolve(process.cwd(), jsonArgs[0]!),
    decisionsPath: resolve(process.cwd(), jsonArgs[1]!),
    seed,
    mode,
    radius: parsePositive(valueAfter("--radius"), mode === "room" ? 4500 : 1500),
    limit: Math.min(256, parsePositive(valueAfter("--limit"), mode === "room" ? 64 : 32)),
    batchSize: Math.min(32, parsePositive(valueAfter("--batch-size"), 32)),
    outputDir: resolve(process.cwd(), valueAfter("--output-dir") ?? "reports/objects"),
  };
}

function distance(a: CadEntity, b: CadEntity): number {
  const aa = a.anchor.local;
  const bb = b.anchor.local;
  if (!aa || !bb) return Number.POSITIVE_INFINITY;
  return Math.hypot(Number(aa[0]) - Number(bb[0]), Number(aa[1]) - Number(bb[1]));
}

function compact(entity: CadEntity, semanticType: string | null, semanticConfidence: number | null) {
  return {
    source_id: entity.id,
    handle: entity.source.handle,
    entity_type: entity.source.entity_type,
    layer: entity.source.layer,
    block_name: entity.source.block?.name ?? null,
    text: entity.text ?? null,
    anchor_local: entity.anchor.local,
    bbox_local: entity.bbox.local,
    geometry: entity.geometry.local,
    entity_semantic_type: semanticType,
    entity_semantic_confidence: semanticConfidence,
  };
}

function keyFor(sourceId: string): string {
  return `r_${createHash("sha1").update(sourceId).digest("hex").slice(0, 12)}`;
}

function elementQuestion(key: string, semanticType: string) {
  const wallGuidance = semanticType === "wall"
    ? " 对 wall 而言，同一对象包括：重合的重复线、同一墙体的两侧轮廓线、端帽线，以及连续表达同一墙段的共线片段；相交但延伸方向不同的墙属于 adjoining/different，而不是同一墙。"
    : "";
  return {
    type: "choice",
    instructions: `根据 state.seed、完整 state.candidates 上下文与 state.candidates[${key}] 的 CAD 证据，判断二者是否共同表达同一个物理 ${semanticType} 组件。空间接近只代表被取回作为上下文，不代表同一对象。${wallGuidance}`,
    criteria: {
      same_object: `候选图元与 seed 共同表达同一个物理 ${semanticType} 组件；可以是重复表达、同一组件的另一侧轮廓或同一连续组件的一部分。`,
      different_object: `候选图元表达另一个 ${semanticType} 对象，或只是附近但不属于 seed。`,
      uncertain: "现有 CAD 证据不足以可靠判断对象归属。",
    },
  };
}

function roomQuestion(key: string) {
  return {
    type: "choice",
    instructions: `state.seed 是目标房间内的名称文字。state.context_annotations 提供附近房间名称和面积文字，state.candidates 提供当前批次的候选集合。只判断 state.candidates[${key}] 是否属于包围 seed 的那一个最直接、最小空间围合；不要把相邻房间、走廊或仅仅靠近的墙算入目标房间。距离仅用于取回上下文。`,
    criteria: {
      boundary: "该图元属于包围目标房间的墙体或边界。",
      opening: "该图元属于目标房间边界上的门或窗洞口。",
      interior: "该图元位于目标房间内部，但不构成边界或洞口。",
      unrelated: "该图元属于相邻房间、走廊或其他对象，与目标房间无直接组成关系。",
      uncertain: "现有证据不足以确定其相对目标房间的角色。",
    },
  };
}

async function request(
  mode: Mode,
  seed: ReturnType<typeof compact>,
  candidates: Array<{ key: string; entity: ReturnType<typeof compact> }>,
  questionKeys: string[],
  semanticType: string,
  contextAnnotations: Array<ReturnType<typeof compact>>,
) {
  const candidateState = Object.fromEntries(candidates.map(({ key, entity }) => [key, entity]));
  const questions = Object.fromEntries(
    questionKeys.map((key) => [key, mode === "element" ? elementQuestion(key, semanticType) : roomQuestion(key)]),
  );
  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(Bun.env.OPENROUTER_SITE_URL ? { "HTTP-Referer": Bun.env.OPENROUTER_SITE_URL } : {}),
      ...(Bun.env.OPENROUTER_APP_NAME ? { "X-OpenRouter-Title": Bun.env.OPENROUTER_APP_NAME } : {}),
    },
    body: JSON.stringify({
      model: MODEL,
      state: { mode, target_semantic_type: semanticType, seed, context_annotations: contextAnnotations, candidates: candidateState },
      questions,
    }),
  });
  const body = (await response.json()) as DecisionsResponse;
  if (!response.ok) {
    throw new Error(`OpenRouter 请求失败 (${response.status}): ${body.error?.message ?? JSON.stringify(body)}`);
  }
  return body;
}

const { cadPath, decisionsPath, seed: seedId, mode, radius, limit, batchSize, outputDir } = parseArgs();
if (!apiKey) {
  console.error("缺少 OPENROUTER_API_KEY，请配置 .env。");
  process.exit(1);
}

const cad = JSON.parse(await readFile(cadPath, "utf8")) as CadIr;
const entityDecisions = JSON.parse(await readFile(decisionsPath, "utf8")) as JevDecisions;
if (cad.schema_version !== "cad-ir-v1" || entityDecisions.schema_version !== "jev-decisions-v1") {
  console.error("输入必须分别是 cad-ir-v1 和 jev-decisions-v1。");
  process.exit(2);
}

const entityById = new Map(cad.entities.map((entity) => [entity.id, entity]));
const decisionById = new Map(entityDecisions.decisions.map((decision) => [decision.source_id, decision]));
const seedEntity = entityById.get(seedId);
if (!seedEntity) {
  console.error(`找不到 seed Source Entity：${seedId}`);
  process.exit(2);
}

const seedDecision = decisionById.get(seedId);
if (mode === "element" && !seedDecision) {
  console.error("element 模式的 seed 必须已有 Jev 实体语义判断。");
  process.exit(2);
}
if (mode === "room" && !(seedEntity.text ?? "").trim()) {
  console.error("room 模式的 seed 必须是包含房间名称的文字图元。");
  process.exit(2);
}

const semanticType = mode === "element" ? seedDecision!.semantic_type : "room";
const eligible = entityDecisions.decisions
  .filter((decision) => decision.source_id !== seedId)
  .filter((decision) => mode === "room" || decision.semantic_type === semanticType)
  .filter((decision) => mode !== "room" || ["wall", "window", "door", "column"].includes(decision.semantic_type))
  .map((decision) => ({ decision, entity: entityById.get(decision.source_id) }))
  .filter((item): item is { decision: EntityDecision; entity: CadEntity } => Boolean(item.entity))
  .map((item) => ({ ...item, distance: distance(seedEntity, item.entity) }))
  .filter((item) => item.distance <= radius)
  .sort((a, b) => a.distance - b.distance)
  .slice(0, limit);

if (eligible.length === 0) {
  console.error(`seed 周围 ${radius} ${cad.source.units.name} 内没有可供 Jev 判断的候选图元。`);
  process.exit(2);
}

const decisions: Array<Record<string, unknown>> = [];
const batches: Array<Record<string, unknown>> = [];
const seedState = compact(seedEntity, seedDecision?.semantic_type ?? null, seedDecision?.confidence ?? null);
const contextAnnotations = mode === "room"
  ? cad.entities
      .filter((entity) => entity.id !== seedId && Boolean((entity.text ?? "").trim()))
      .map((entity) => ({ entity, distance: distance(seedEntity, entity) }))
      .filter((item) => item.distance <= radius)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 32)
      .map(({ entity }) => compact(entity, decisionById.get(entity.id)?.semantic_type ?? null, decisionById.get(entity.id)?.confidence ?? null))
  : [];
const allCandidates = eligible.map(({ entity, decision }) => ({
  key: keyFor(entity.id),
  entity: compact(entity, decision.semantic_type, decision.confidence),
}));

for (let index = 0; index < eligible.length; index += batchSize) {
  const candidates = allCandidates.slice(index, index + batchSize);
  const body = await request(mode, seedState, candidates, candidates.map(({ key }) => key), semanticType, contextAnnotations);
  batches.push({
    index: Math.floor(index / batchSize),
    candidate_count: candidates.length,
    request_id: body.id ?? null,
    model: body.model ?? MODEL,
    provider: body.provider ?? null,
    usage: body.usage ?? null,
  });
  for (const { key, entity } of candidates) {
    const answer = body.answers?.[key];
    decisions.push({
      source_id: entity.source_id,
      role: answer?.choice ?? "uncertain",
      confidence: answer?.confidence ?? null,
      probabilities: answer?.probabilities ?? {},
      model: body.model ?? MODEL,
      request_id: body.id ?? null,
    });
  }
  console.error(`Jev object batch ${Math.floor(index / batchSize) + 1}/${Math.ceil(eligible.length / batchSize)} 完成`);
}

const acceptedRoles = mode === "element" ? new Set(["same_object"]) : new Set(["boundary", "opening", "interior"]);
const accepted = decisions.filter((decision) => acceptedRoles.has(String(decision.role))).map((decision) => decision.source_id);
const roomBoundaryEntities = mode === "room"
  ? decisions
      .filter((decision) => decision.role === "boundary")
      .map((decision) => entityById.get(String(decision.source_id)))
      .filter((entity): entity is CadEntity => Boolean(entity))
  : [];
const objectId = `${mode}-${createHash("sha1").update(`${seedId}:${MODEL}:${mode}`).digest("hex").slice(0, 12)}`;
const result = {
  schema_version: "jev-object-decisions-v1",
  generated_at: new Date().toISOString(),
  model: MODEL,
  endpoint: OPENROUTER_URL,
  input: {
    cad_ir_path: cadPath,
    jev_decisions_path: decisionsPath,
    region_id: cad.selection.region_id,
    window_id: entityDecisions.selection?.window_id ?? null,
    source_sha256: cad.source.sha256,
  },
  query: { mode, seed_source_id: seedId, seed_text: seedEntity.text ?? null, semantic_type: semanticType, radius, candidate_limit: limit },
  object: {
    id: objectId,
    semantic_type: semanticType,
    seed_source_id: seedId,
    source_entities: mode === "element" ? [seedId, ...accepted] : accepted,
    roles: mode === "room"
      ? Object.fromEntries(decisions.filter((decision) => acceptedRoles.has(String(decision.role))).map((decision) => [String(decision.source_id), decision.role]))
      : null,
    geometry_validation: mode === "room" ? validateRoomBoundary(roomBoundaryEntities) : null,
  },
  summary: {
    candidate_count: eligible.length,
    decision_count: decisions.length,
    accepted_count: accepted.length,
    role_counts: decisions.reduce<Record<string, number>>((counts, decision) => {
      const role = String(decision.role ?? "uncertain");
      counts[role] = (counts[role] ?? 0) + 1;
      return counts;
    }, {}),
  },
  batches,
  decisions,
};

await mkdir(outputDir, { recursive: true });
const stem = basename(cadPath).replace(/\.cad-ir\.json$/, "");
const output = resolve(outputDir, `${stem}.${mode}.${seedEntity.source.handle}.jev-object.json`);
await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ output, object: result.object, summary: result.summary }, null, 2));
