# Bun + OpenRouter Jev

用 Bun 和 TypeScript 调用 OpenRouter 的 TypeSafe Jev Decisions API，示例是情绪分类。

## 项目文档

- [领域词汇](./CONTEXT.md)
- [DXF 到语义 3D 架构](./docs/architecture.md)
- [当前 DXF 样本画像](./docs/data-profile.md)
- [实施方案](./docs/implementation-plan.md)
- [房间边界求解 v3 设计](./docs/room-boundary-v3-design.md)
- [ADR：Semantic CAD IR 与 Blender 解耦](./docs/adr/0001-semantic-cad-ir-boundary.md)
- [ADR：Jev 负责语义决策](./docs/adr/0002-jev-owns-semantic-decisions.md)
- [ADR：候选优先的统一房间边界图](./docs/adr/0004-candidate-first-room-boundary-graph.md)

## Stage 0：DXF 扫描

运行默认的 `data/*.dxf`：

```bash
bun run inventory
```

也可以指定文件和区域发现参数：

```bash
bun run inventory data/example.dxf \
  --cell-size-mm 50000 \
  --min-cell-entities 20 \
  --halo-cells 1
```

报告输出到 `reports/inventory/`，包括机器可读 JSON 和 Markdown 摘要。扫描器通过 `uv` 运行固定版本的 `ezdxf`，不会递归展开大型块定义。

当前样本比较过 `25000`、`50000` 和 `100000` mm 三种网格。默认使用 `50000` mm：更大的网格会合并相邻图纸，更小的网格会产生过多碎片。区域发现结果仍属于候选，Stage 1 会结合标题、图框和几何边界进一步确认。

## Stage 1：导出 CAD IR

先运行 Stage 0，再按区域 ID 导出：

```bash
bun run export-region --region region-a8ec9a559249
```

输出到 `reports/cad-ir/`。导出的实体保留 DXF handle、原始图层、块引用、源坐标、区域局部坐标和几何 payload；块定义默认不展开。

包含建筑语义图层的验证区域：

```bash
bun run export-region --region region-c665ea89ba4f
```

该区域包含 `WALL`、`WINDOW`、`PL-DOOR` 和 `COLUMN` 图层，适合后续进入候选提取阶段。

## Stage 1.5：Analysis Window

在 CAD IR 上生成 core + halo 窗口：

```bash
bun run windows reports/cad-ir/广州市妇女儿童医疗中心珠江新城院区总平顶视图.region-c665ea89ba4f.cad-ir.json
```

默认 core 为 `25000`，halo 为 `2000` 个图纸单位。输出到 `reports/windows/`，窗口只保存实体引用，几何仍由 CAD IR 提供。

## Stage 2：确定性语义基线

读取 CAD IR 和 Analysis Window，按图层、块名和实体类型生成可解释的语义候选：

```bash
bun run baseline reports/cad-ir/广州市妇女儿童医疗中心珠江新城院区总平顶视图.region-c665ea89ba4f.cad-ir.json
```

输出到 `reports/semantic/`。每个候选包含来源实体、窗口归属、证据、规则版本、置信度和备选类型。这些结果只用于诊断与对照；主路径会把选定范围内的源事实交给 Jev，而不是只把规则标记为 `unknown` 的实体交给 Jev。

## Stage 2.1：候选关系

在确定性基线之上生成墙体配对和门窗关联：

```bash
bun run enrich reports/semantic/广州市妇女儿童医疗中心珠江新城院区总平顶视图.region-c665ea89ba4f.semantic-baseline.json
```

默认把两条平行、重叠、间距在 `40～600` mm 的墙线组成 `wall_pair`，并把距离墙线不超过 `600` mm 的门窗候选关联为 `opening_on_wall`。

这部分关系输出保留为诊断和对照工具，不作为主语义决策路径。

## Stage 3：Jev 语义决策

主路径把 CAD IR 的源事实和几何证据交给 Jev，由 Jev 判断语义类型：

```bash
# 先发送 32 个实体做试运行
bun run jev reports/cad-ir/广州市妇女儿童医疗中心珠江新城院区总平顶视图.region-c665ea89ba4f.cad-ir.json

# 确认请求结构和费用后发送整个 CAD IR
bun run jev reports/cad-ir/广州市妇女儿童医疗中心珠江新城院区总平顶视图.region-c665ea89ba4f.cad-ir.json --all

# 对一个 Analysis Window 做全量识别
bun run jev reports/cad-ir/广州市妇女儿童医疗中心珠江新城院区总平顶视图.region-c665ea89ba4f.cad-ir.json \
  --windows reports/windows/广州市妇女儿童医疗中心珠江新城院区总平顶视图.region-c665ea89ba4f.analysis-windows.json \
  --window window-0f28c192908f \
  --all
```

输出到 `reports/jev/`。每个决定保留 Jev 返回的类型、置信度、概率、模型和 request ID。`semantic_baseline` 与 `semantic_enrichment` 仍可用于对照，但不会覆盖 Jev 的结果。

## Stage 3.5：对象与房间关系

以一个已有 Jev 类型的图元为 seed，判断附近同类型图元是否属于同一个物理对象：

```bash
bun run jev-object <cad-ir.json> <jev-decisions.json> \
  --seed source:3DFDDA \
  --mode element \
  --radius 1200
```

以包含房间名称的文字图元作为 Room Seed：

```bash
bun run jev-object <cad-ir.json> <jev-decisions.json> \
  --seed source:3DFB32 \
  --mode room \
  --radius 3500 \
  --limit 64
```

Jev 决定对象成员和房间角色。代码只负责限制上下文与检查 Jev 选出的边界是否闭合。输出保存到 `reports/objects/`。

## Stage 3.6：有序房间边界

从房间附近的 Jev 墙判断生成临时墙元素，并由 Jev 合并同一墙对象：

```bash
bun run wall-elements <cad-ir.json> <jev-decisions.json> <room-object.json>
bun run group-walls <wall-elements.json>
bun run segment-walls <grouped-wall-elements.json>
```

运行带概率分支的顺序遍历：

```bash
bun run room-traverse <cad-ir.json> <jev-decisions.json> \
  <segmented-wall-elements.json> <room-object.json> \
  --beam-width 5 \
  --max-steps 20
```

如果附近存在家具、柜台、设备或详图图层干扰，先让 Jev 对房间搜索范围内的图层做一次批量选择：

```bash
bun run jev-room-layers <cad-ir.json> <jev-decisions.json> \
  <segmented-wall-elements.json> <room-object.json> \
  --traversal <room-traversal.json>

bun run room-traverse <cad-ir.json> <jev-decisions.json> \
  <segmented-wall-elements.json> <room-object.json> \
  --layer-decisions <room-layer-decisions.json>
```

`include` 图层进入主要 face 图，`uncertain` 只作为受约束的 repair 证据，`exclude` 完全移出房间拓扑。与已有房间成员判断冲突或排除置信度过低的决定会降级为 `uncertain`，不会直接删除门窗、柱等物理边界证据。

遍历结果记录每一步 Jev 选择、概率、墙对象、Virtual Boundary Edge、闭合验证和 Room Seed/面积检查，输出到 `reports/traversal/`。

## 房间求解实验 v2

新入口 `room-resolve` 使用真实 DXF 展开几何、Jev 对象空间关系、显式虚拟连接选择、face 提取及最终 Jev 裁决。旧 `room-traverse` 保留作对照；其闭合候选也已恢复最终 Jev 裁决。v2 尚未替换旧流水线，不能将几何闭合或模型接受等同于人工确认正确。

```bash
uv run scripts/room_geometry.py <cad-ir.json> reports/room-v2/source-geometry.json
bun run room-resolve <cad-ir.json> <jev-decisions.json> \
  reports/room-v2/source-geometry.json --seed source:ID \
  --output-dir reports/room-v2/runs

# 严格离线回放：输入内容、代码和参数必须一致，输出目录须不同
bun run room-resolve <cad-ir.json> <jev-decisions.json> \
  reports/room-v2/source-geometry.json --seed source:ID \
  --replay reports/room-v2/runs/source-ID.json \
  --output-dir reports/room-v2/replay
```

所有房间默认使用同一预算：初始半径 4000 mm / 48 个对象，最大半径 6500 mm / 96 个对象，最多两轮、32 次请求。扩大上下文优先检索断口附近对象。请求按大小拆分时保留共同上下文，原始响应和输入/代码哈希保存在报告中；运行中也写入 journal。请求失败不能触发本地接受。

第二轮按断口轮换分配新增图元名额，记录各图元的检索焦点；对象关系请求附带相邻已选边界的实际区段。这些只作为 Jev 的判断证据。该轮六房间实测为 0/6 接受，见 `docs/room-frontier-results.md`。

v2 不使用图层硬过滤、最近面积自动接受、seed 同侧硬过滤或父对象全局不可重入规则。它验证实际区段连续性、闭合、自交、区段复用和内部障碍物；门窗开口连接必须由 Jev 选择。`same_space` 表达线不进入分隔图，因此其两侧 face 可合并。

候选失败后的第二轮会向 Jev 提交具体表面区段及上轮失败轮廓：允许保留、排除或恢复此前遗漏的区段，不再只重新判断整个父图元。障碍物与边界冲突会交回模型复核。默认每轮最多复核 48 个表面，受总请求预算限制，可用 `--surfaces` 配置；这仍是有界检索，不保证包含正确边界的所有表面。

优化算法时可用 `--reuse-decisions <previous-report.json>` 复用完全相同请求的成功响应；证据或问题有任何变化都会重新请求 Jev。此模式不同于严格 `--replay`，报告分别记录来源与 `fresh_request_count`，不能视为独立重复实验。

最终一轮仍失败时，会从局部墙/窗/柱语义池生成待审查的结构候选。候选保留已知障碍物与原始关系，门扇、楼梯线和已判开口对象不直接当作外墙。默认最多检索 220 个对象、1200 个区段（`--hypothesis-objects` / `--hypothesis-segments`），不截断单个对象；这与逐对象关系请求的 96 个对象预算分别记录。结构候选中的边界全部标为待审查，最终接受只批准该候选展示的区段，不覆盖整个源对象的历史关系。本轮新增 37 次模型请求，六房间仍为 0/6 接受；70 项测试及类型检查通过。详见 `docs/room-structural-hypotheses-results.md`。

目前限制：仅支持毫米单位；弧线以 1 mm 误差展开；表面复核仅覆盖有限候选，跨实体物理对象身份尚未完整解决；开放功能区返回范围未决；未实现所有非端点式开口接点；候选检索受固定预算限制；还没有跨图纸人工真值评测。详见 `docs/room-boundary-redesign.md`。

## 准备环境

1. 在 OpenRouter 创建 API key。
2. 复制环境变量文件并填写 key：

   ```bash
   cp .env.example .env
   ```

3. 安装 TypeScript 类型依赖：

   ```bash
   bun install
   ```

默认使用 `typesafe/jev-1.13`。OpenRouter 页面里的 `~typesafe/jev-latest` 是页面别名，当前不能直接作为 Decisions API 的 `model` 值；如果模型版本更新，可在 `.env` 中修改 `OPENROUTER_MODEL`。

## 运行

传入命令行文本：

```bash
bun run start "这个产品真的很棒，我非常满意。"
```

也可以通过 stdin：

```bash
echo "服务太慢了，我很失望" | bun run start
```

输出示例：

```json
{
  "model": "typesafe/jev-1.13",
  "text": "这个产品真的很棒，我非常满意。",
  "choice": "positive",
  "confidence": 0.99,
  "probabilities": {
    "positive": 0.99,
    "neutral": 0.01,
    "negative": 0
  }
}
```

`src/index.ts` 中的 `state`、`questions` 和 `criteria` 是 Jev 的核心输入。把它们替换成你的业务字段和决策标签，就可以做路由、审核、风控等自动化判断。
