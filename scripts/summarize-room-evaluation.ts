import { readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { evidenceHash } from "../src/jev-boundary-decisions";

const directory = resolve(Bun.argv[2] ?? "reports/room-v2/evaluation");
const paths = (await readdir(directory)).filter((name) => /^source-.*\.json$/.test(name) && !name.includes("journal")).sort();
const reports = await Promise.all(paths.map(async (path) => ({ path, report: await Bun.file(resolve(directory, path)).json() })));
const groups = new Set(reports.map(({ report }) => evidenceHash({ sources: report.run_manifest.source_hashes, policy: report.policy, inputs: report.run_manifest.input_hashes })));
if (groups.size !== 1) throw new Error("评测输入、算法或预算不一致，不能汇总为同一轮评测");
const rows = reports.map(({ path, report: r }) => ({
  seed: r.room_seed.source_id, room: r.room_seed.text, outcome: r.outcome, reason: r.outcome_reason,
  requests: r.request_count, candidate_count: r.candidates.length,
  fresh_requests: r.fresh_request_count ?? null,
  reuse_source: r.reuse_source ?? null,
  surfaces_reviewed: r.surface_decisions?.length ?? 0,
  surface_non_boundary_choices: r.surface_decisions?.filter((d: any) => d.choice === "non_boundary").length ?? 0,
  surface_review_coverage: r.traces.filter((t: any) => t.stage === "surface_review").map((t: any) => t.coverage ?? null),
  valid_candidate_count: r.candidates.filter((c: any) => !c.defects.length).length,
  candidate_areas_m2: r.candidates.map((c: any) => Number((c.gross_area / 1e6).toFixed(3))),
  candidate_defects: r.candidates.flatMap((c: any) => c.defects),
  request_errors: r.decision_records.filter((d: any) => d.status !== "ok").map((d: any) => ({ status: d.status, error: d.response?.error ?? d.error })),
  approved_gaps: r.approved_gaps.length,
  structural_hypotheses: r.traces.filter((t: any) => t.stage === "structural_local_hypotheses").map((t: any) => ({
    round: t.round, eligible_objects: t.eligible_objects, selected_objects: t.selected_object_ids?.length,
    segments: t.segments, obstacle_count: t.obstacle_count,
    objects_truncated: t.objects_truncated, candidates_truncated: t.candidates_truncated,
    candidate_count: t.candidates.length,
    valid_candidate_count: t.candidates.filter((c: any) => c.defects?.length === 0).length,
  })),
  graph_relations: Object.values(r.object_relations).reduce((acc: Record<string, number>, role: any) => { acc[role] = (acc[role] ?? 0) + 1; return acc; }, {}),
  report: path,
}));
const summary = { schema_version: "room-evaluation-v1", same_input_geometry_and_policy: true, policy: reports[0]!.report.policy,
  room_count: rows.length, accepted_count: rows.filter((r) => r.outcome === "accepted").length, rows,
  limitations: ["同一图纸开发性评测，不是跨图纸泛化验证", "没有独立人工真值；accepted 也不等于确认正确", "旧报告预处理不同，不将历史数字当作公平准确率对比"] };
await writeFile(resolve(directory, "summary.json"), JSON.stringify(summary, null, 2));
const lines = ["# 房间求解 v2：统一配置实测", "", `房间数：${rows.length}；模型接受：${summary.accepted_count}。`, "",
  "| 房间 | Seed | 结果 | 原因 | 候选面积㎡ | Jev请求 |", "|---|---|---|---|---|---|",
  ...rows.map((r) => `| ${r.room} | ${r.seed} | ${r.outcome} | ${r.reason} | ${r.candidate_areas_m2.join(", ") || "—"} | ${r.requests} |`),
  "", "全部使用相同 DXF 展开几何、源语义、算法代码和预算。详细原始请求及响应保存在各房间 JSON 中。", "",
  ...summary.limitations.map((s) => `- ${s}`), "",
  "这些结果衡量当前端到端求解的实际完成情况，不将拒绝错误候选包装为识别成功。", "",
];
await writeFile(resolve(directory, "summary.md"), lines.join("\n"));
console.log(JSON.stringify(summary, null, 2));
