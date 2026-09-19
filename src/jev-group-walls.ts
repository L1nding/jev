import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { distanceToSegment } from "./room-traversal";
import type { Point2, WallElement } from "./wall-elements";

type PairCandidate = {
  key: string;
  a: WallElement;
  b: WallElement;
  angle_difference_degrees: number;
  separation: number;
  axial_gap: number;
};

type DecisionsResponse = {
  id?: string;
  model?: string;
  provider?: string;
  usage?: Record<string, unknown>;
  answers?: Record<string, { choice?: string; confidence?: number; probabilities?: Record<string, number> }>;
  error?: { message?: string };
};

const OPENROUTER_URL = "https://openrouter.ai/api/alpha/decisions";
const MODEL = Bun.env.OPENROUTER_MODEL ?? "typesafe/jev-1.13";
const apiKey = Bun.env.OPENROUTER_API_KEY;

function direction(element: WallElement): Point2 {
  const dx = element.end[0] - element.start[0];
  const dy = element.end[1] - element.start[1];
  const length = Math.hypot(dx, dy) || 1;
  return [dx / length, dy / length];
}

function angleDifference(a: WallElement, b: WallElement): number {
  const da = direction(a);
  const db = direction(b);
  const cosine = Math.min(1, Math.max(-1, Math.abs(da[0] * db[0] + da[1] * db[1])));
  return Math.acos(cosine) * 180 / Math.PI;
}

function separation(a: WallElement, b: WallElement): number {
  return Math.min(
    distanceToSegment(a.start, b.start, b.end),
    distanceToSegment(a.end, b.start, b.end),
    distanceToSegment(b.start, a.start, a.end),
    distanceToSegment(b.end, a.start, a.end),
  );
}

function axialGap(a: WallElement, b: WallElement): number {
  const axis = direction(a);
  const project = (point: Point2) => point[0] * axis[0] + point[1] * axis[1];
  const aa = [project(a.start), project(a.end)].sort((x, y) => x - y);
  const bb = [project(b.start), project(b.end)].sort((x, y) => x - y);
  if (aa[1]! >= bb[0]! && bb[1]! >= aa[0]!) return 0;
  return Math.min(Math.abs(bb[0]! - aa[1]!), Math.abs(aa[0]! - bb[1]!));
}

function pairCandidates(elements: WallElement[], maximumSeparation: number, maximumGap: number): PairCandidate[] {
  const pairs: PairCandidate[] = [];
  for (let aIndex = 0; aIndex < elements.length; aIndex += 1) {
    for (let bIndex = aIndex + 1; bIndex < elements.length; bIndex += 1) {
      const a = elements[aIndex]!;
      const b = elements[bIndex]!;
      const angle = angleDifference(a, b);
      if (angle > 10) continue;
      const pairSeparation = separation(a, b);
      const gap = axialGap(a, b);
      if (pairSeparation > maximumSeparation || gap > maximumGap) continue;
      pairs.push({
        key: `p_${createHash("sha1").update(`${a.id}|${b.id}`).digest("hex").slice(0, 12)}`,
        a,
        b,
        angle_difference_degrees: angle,
        separation: pairSeparation,
        axial_gap: gap,
      });
    }
  }
  return pairs;
}

function buildGroupedElement(index: number, members: WallElement[]): WallElement {
  const dominant = [...members].sort((a, b) => b.length - a.length)[0]!;
  const axis = direction(dominant);
  const perpendicular: Point2 = [-axis[1], axis[0]];
  const endpoints = members.flatMap((member) => [member.start, member.end]);
  const along = endpoints.map((point) => point[0] * axis[0] + point[1] * axis[1]);
  const offsets = endpoints.map((point) => point[0] * perpendicular[0] + point[1] * perpendicular[1]);
  const minimum = Math.min(...along);
  const maximum = Math.max(...along);
  const offset = offsets.reduce((sum, value) => sum + value, 0) / offsets.length;
  const start: Point2 = [axis[0] * minimum + perpendicular[0] * offset, axis[1] * minimum + perpendicular[1] * offset];
  const end: Point2 = [axis[0] * maximum + perpendicular[0] * offset, axis[1] * maximum + perpendicular[1] * offset];
  const memberIds = members.map((member) => member.id).sort();
  const sourceEntities = [...new Set(members.flatMap((member) => member.source_entities))].sort();
  return {
    id: `wall-group:${String(index).padStart(3, "0")}:${createHash("sha1").update(memberIds.join("|")).digest("hex").slice(0, 8)}`,
    status: members.length > 1 ? "jev-grouped" : "provisional",
    source_entities: sourceEntities,
    source_segment_index: -1,
    member_element_ids: memberIds,
    start,
    end,
    length: Math.hypot(end[0] - start[0], end[1] - start[1]),
    semantic_confidence: Math.min(...members.map((member) => member.semantic_confidence ?? 0)),
    semantic_model: members.find((member) => member.semantic_model)?.semantic_model ?? null,
    semantic_request_id: null,
  };
}

const args = Bun.argv.slice(2);
const inputArg = args.find((value) => value.endsWith(".wall-elements.json"));
const valueAfter = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
if (!inputArg) {
  console.error("用法：bun run group-walls <wall-elements.json> [--maximum-separation 350] [--maximum-gap 250]");
  process.exit(2);
}
if (!apiKey) {
  console.error("缺少 OPENROUTER_API_KEY，请配置 .env。");
  process.exit(1);
}

const input = resolve(inputArg);
const maximumSeparation = Number(valueAfter("--maximum-separation") ?? 350);
const maximumGap = Number(valueAfter("--maximum-gap") ?? 250);
const batchSize = Math.min(32, Number(valueAfter("--batch-size") ?? 32));
const outputDir = resolve(valueAfter("--output-dir") ?? "reports/wall-elements");
const document = JSON.parse(await readFile(input, "utf8"));
const elements = document.elements as WallElement[];
const pairs = pairCandidates(elements, maximumSeparation, maximumGap);
const relationDecisions: Array<Record<string, unknown>> = [];
const parent = new Map(elements.map((element) => [element.id, element.id]));
const find = (id: string): string => {
  const current = parent.get(id)!;
  if (current === id) return id;
  const root = find(current);
  parent.set(id, root);
  return root;
};
const union = (a: string, b: string) => {
  const rootA = find(a);
  const rootB = find(b);
  if (rootA !== rootB) parent.set(rootB, rootA);
};

for (let index = 0; index < pairs.length; index += batchSize) {
  const batch = pairs.slice(index, index + batchSize);
  const statePairs = Object.fromEntries(batch.map((pair) => [pair.key, {
    a: pair.a,
    b: pair.b,
    geometry_features: {
      angle_difference_degrees: pair.angle_difference_degrees,
      separation: pair.separation,
      axial_gap: pair.axial_gap,
    },
  }]));
  const questions = Object.fromEntries(batch.map((pair) => [pair.key, {
    type: "choice",
    instructions: `判断 state.pairs.${pair.key} 中的两条已被 Jev 判为 wall 的墙段是否共同表达同一个物理墙对象。重合重复线、同一墙的两侧轮廓以及同一方向的连续片段可以属于同一墙；相邻房间的平行墙、仅仅靠近的墙或不同墙对象必须分开。`,
    criteria: {
      same_wall_assembly: "两条墙段共同表达同一个物理墙对象。",
      different_wall: "两条墙段属于不同墙对象。",
      uncertain: "现有证据不足以可靠判断。",
    },
  }]));
  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, state: { room_seed: document.room_seed, pairs: statePairs }, questions }),
  });
  const body = (await response.json()) as DecisionsResponse;
  if (!response.ok) throw new Error(`OpenRouter 请求失败 (${response.status}): ${body.error?.message ?? JSON.stringify(body)}`);
  for (const pair of batch) {
    const answer = body.answers?.[pair.key];
    const relation = answer?.choice ?? "uncertain";
    if (relation === "same_wall_assembly") union(pair.a.id, pair.b.id);
    relationDecisions.push({
      pair_key: pair.key,
      a: pair.a.id,
      b: pair.b.id,
      relation,
      confidence: answer?.confidence ?? null,
      probabilities: answer?.probabilities ?? {},
      geometry_features: { angle_difference_degrees: pair.angle_difference_degrees, separation: pair.separation, axial_gap: pair.axial_gap },
      model: body.model ?? MODEL,
      request_id: body.id ?? null,
    });
  }
  console.error(`Jev wall grouping batch ${Math.floor(index / batchSize) + 1}/${Math.ceil(pairs.length / batchSize)} 完成`);
}

const groups = new Map<string, WallElement[]>();
for (const element of elements) {
  const root = find(element.id);
  groups.set(root, [...(groups.get(root) ?? []), element]);
}
const groupedElements = [...groups.values()]
  .sort((a, b) => a.map((element) => element.id).sort()[0]!.localeCompare(b.map((element) => element.id).sort()[0]!))
  .map((members, index) => buildGroupedElement(index, members));

const result = {
  ...document,
  schema_version: "wall-elements-v2",
  generated_at: new Date().toISOString(),
  grouping: { authority: "jev", model: MODEL, maximum_separation: maximumSeparation, maximum_gap: maximumGap, pair_candidate_count: pairs.length },
  summary: {
    input_wall_element_count: elements.length,
    grouped_wall_element_count: groupedElements.length,
    multi_member_group_count: groupedElements.filter((element) => (element.member_element_ids?.length ?? 0) > 1).length,
    same_wall_relation_count: relationDecisions.filter((decision) => decision.relation === "same_wall_assembly").length,
  },
  elements: groupedElements,
  relation_decisions: relationDecisions,
};

await mkdir(outputDir, { recursive: true });
const stem = basename(input).replace(/\.wall-elements\.json$/, "");
const output = resolve(outputDir, `${stem}.grouped-wall-elements.json`);
await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ output, ...result.summary }, null, 2));
