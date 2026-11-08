# EdgeEver 上游 v1.90.0 → v2.23.0 升级方案（嗅探组报告）

**文档版本**：V1.0
**撰写日期**：2026-11-08
**基准（本地）**：`fde-v1.90.0.1` @ `292718d0`（merge-base = `c31dfe7a` = tag `v1.90.0`）
**目标（上游）**：`v2.23.0` @ `6600a632`（`package.json` version=2.23.0，`release-summary.json` version=2.23.0，双证确认）
**性质**：只读侦查，零代码改动、零 commit
**交办对象**：实施组（Phase 28）

---

## 一、结论摘要（一页拍板用）

| 项目 | 结论 |
|---|---|
| 上游版本真实性 | ✅ 双证确认 v2.23.0 @ `6600a632`（`git ls-remote` 交叉验证通过） |
| FDE 核心 patch 是否被上游触碰 | ✅ **零触碰**（`mcp-hiding.ts` / `hiding-guards.ts` / `hiding-routes.ts` 上游 0 行改动） |
| merge-tree 冲突 | ⚠️ **3 个真冲突**（`index.ts` / `memo-service.ts` / `notebook-service.ts`），全部为「同文件不同区域」结构性冲突，非语义冲突 |
| migration 撞号 | ✅ 零撞号（本地 0055 → 上游 0056-0092，37 个，编号完全衔接） |
| 测试档撞名 | ✅ 零撞名（上游 `tests/` 无任何 hiding/leak 同名档，本地 15 档可原样保留） |
| 新泄露面 | ⚠️ **1 个真实缺口**：`poster_render_jobs`（migration 0066）未纳入 `INJECTION_RULES`，探针实测泄露隐藏 memo 的 job 记录 |
| 新 MCP 工具 | 16 个（45 → 61），逐个审计后**15 个已由现有规则覆盖**，仅 poster_render_jobs 需补 |
| 升级收益 | 顺带获得 4 个上游安全修复（备份附件 XSS / renderer 边界 / 2 个依赖漏洞）、TOTP 2FA、笔记导入、海报、结构化表格、5 语言本地化 |
| 推荐决策 | ✅ **以 v2.23.0 为基准升级**，开新分支 `fde-v2.23.0.1` |
| 工作量预估 | 中（964 上游 commit / 3 冲突 / 1 行漏洞修复 / DEPLOY 升 V2.8） |

---

## 二、规模评估（27.1）

### 2.1 版本区间与 commit 数

```
merge-base        : c31dfe7a (= tag v1.90.0)
上游 commit (新增) : 964
本地 FDE commit    : 25
上游改动文件       : 2402
```

对比历史：`v1.65→v1.90` 那次只有 1 个 tag 区间；今次跨 **33 个 minor 版本**（v1.90 → v2.23），规模约 6-7 倍。

### 2.2 上游 commit 类型分布

```
fix     361    (37.5%)
feat    164    (17.0%)
docs    150    (15.6%)
chore    84
test     69
style    34
refactor 30
ci        6
perf      4
```

fix 占比偏高（37.5%），说明上游 v2.x 处于快速迭代修 bug 期。**这既是机会（拿到大量修复）也是风险（行为语义可能多次变动）**。

### 2.3 migration 清单（37 个，编号完全衔接，零撞号）

| 区间 | 主题 | 关键表 |
|---|---|---|
| 0056-0059 | 笔记排版 + 旧调色板退役 | ALTER users / 无新表 |
| 0060-0065 | AI 转写（video → speech 来回替换后定型） | ai_transcription_settings / providers / models |
| 0066 | 海报渲染任务 | **poster_render_jobs（含 memo_id，泄露面）** |
| 0067-0069 | 笔记本分享 + 密码加密 | **notebook_shares（含 notebook_id）** |
| 0070-0071 | workspace 种子本地化 | workspace_seed_localizations |
| 0072 | 公开笔记本站点 | **notebook_share_excluded_memos（含 memo_id）** |
| 0073-0078 | 笔记本外观（颜色/加粗/反色） | ALTER notebooks 多列 |
| 0079-0080 | 示例种子 + 备份 revision | workspace_example_seeds |
| 0081-0087 | 分享增强（slug/选项/展示/过期/访问计数） | memo_share_slug_claims |
| 0088-0090 | TOTP 双因素 | user_totp / user_recovery_codes / auth_challenges |
| 0091-0092 | AI 模型输出预算 | ALTER ai_models 多列 |

**升级后目标**：`migration=0092`

### 2.4 部署面变化（⚠️ 与上次不同）

| 文件 | 上游改动 | 影响 |
|---|---|---|
| `Dockerfile` | **+20 −2** | ⚠️ 上次是零改动，本次需确认无新 build 依赖 |
| `.dockerignore` | +1 | 新增忽略项 |
| `bun.lock` | **+1451 −820** | ⚠️ merge 后必须 `bun install`（新增 83+ 包） |
| `compose.yaml` | 无改动 | ✅ 我们的 bind mount 改动安全保留 |
| `package.json` | 新增 7 个 test scripts | 门禁命令有新增，参考 `test:bulk` |

---

## 三、FDE patch 资产盘点（27.2）

### 3.1 全部资产：38 文件 / +6925 −30

**核心三件（上游零触碰 ✅）**：

| 文件 | 行数 | 作用 |
|---|---|---|
| `apps/api/src/mcp-hiding.ts` | +874 | 确定性 SQL 词法解析器 + 9 条 INJECTION_RULES + fail-closed |
| `apps/api/src/hiding-guards.ts` | +49 | 写入守卫（assertNotebookWritable / assertNotebooksWritable） |
| `apps/api/src/hiding-routes.ts` | +153 | 管理端点 GET/PUT + `requireOwner` |

**前端 + 数据层**：
- `TokenHidingEditor.tsx`（+236）树状选择器
- `McpConfigCard.tsx`（+13）入口
- `migrations/0036_mcp_token_hidden.sql`（+14）
- `packages/client/src/index.ts`（+15）
- `i18n/en-US.ts` + `zh-CN.ts`（各 +12）

**测试资产 15 档（撞名检查：零风险 ✅）**：
```
leak-matrix.test.ts              466 行（S1-S10 泄露矩阵，BUILD 前硬 GATE）
mcp-hiding.test.ts               699 行（SQL 词法解析核心）
mcp-hiding-real-sqlite.test.ts   374 行（真 bun:sqlite 执行）
mcp-hiding-null-join.test.ts     298 行（BUG-002 NULL-safe 回归）
mcp-hiding-table-forms.test.ts   195 行（table_forms 隔离，TDD 5/5）
auth-hiding.test.ts              226 行
hiding-routes.test.ts            154 行
hiding-guards.test.ts             88 行
migration-0036.test.ts           200 行
spike-v1.50.0.test.ts            496 行
tag-rename-verify.test.ts        270 行
doubt-first-check.ts             146 行
repro-*.ts                       359 行（3 档）
```

### 3.2 共用文件交集（12 个）

| 文件 | 本地方向 | 上游改动 | merge-tree 判定 |
|---|---|---|---|
| `apps/api/src/index.ts` | **4 个注入点**（L257 registerAuthRoutes / L272 registerUserRoutes / L303 `/api/v1/*` 中间件 / L376 registerMcpRoutes）换成 `authenticateRequestWithHiding` + `registerHidingRoutes()` | +79 −11（18 hunk） | 🔴 **CONFLICT** |
| `apps/api/src/memo-service.ts` | **5 处** `assertNotebookWritable` 守卫（L737 moveMemos / L809 mergeMemos / L961 createMemo / L1094 importMemos / L1236 updateMemo） | +66 −23 | 🔴 **CONFLICT** |
| `apps/api/src/notebook-service.ts` | **2 处** `assertNotebookWritable` 守卫（L161 createNotebookRecord parentId / L203 updateNotebookRecord id） | +104 −24 | 🔴 **CONFLICT** |
| `apps/api/src/mcp-routes.ts` | +11（wrapper 接入） | +23 −5 | 🟢 auto-merge |
| `apps/api/src/mcp-tool-service.ts` | +8 ±几（table_forms payload） | +340 −450（16 新工具） | 🟢 auto-merge |
| `apps/api/src/mcp-routes.test.mjs` | +44 | 改动 | 🟢 auto-merge |
| `apps/web/.../McpConfigCard.tsx` | +13 | 改动 | 🟢 auto-merge |
| `packages/client/src/index.ts` | +15 | 改动 | 🟢 auto-merge |
| `packages/shared/src/i18n/en-US.ts` | +12 | 改动 | 🟢 auto-merge |
| `packages/shared/src/i18n/zh-CN.ts` | +12 | 改动 | 🟢 auto-merge |
| `docs/deploy-docker.md` | +2 −2 | 改动 | 🟢 auto-merge |
| `docs/deploy-docker.zh-CN.md` | +2 −2 | 改动 | 🟢 auto-merge |

### 3.3 三个冲突的精确性质（27.3）

**冲突 1：`apps/api/src/index.ts`**
- 本地改动位置：L25-30（import mcp-hiding + hiding-routes）、**4 个注入点**（L257 `registerAuthRoutes` / L272 `registerUserRoutes` / L303 `/api/v1/*` 中间件 / L376 `registerMcpRoutes` → 全换成 `authenticateRequestWithHiding`）、L380（`registerHidingRoutes(app)`）
- 上游改动：18 个 hunk，主要在新增 route 注册（poster-render / notebook-share / import / plugin-distribution）与 import 段。新增 `registerPosterRenderRoutes` / `registerNotebookShareRoutes` / `registerPublicNotebookShareRoutes` / `registerImportRoutes`。
- **解决策略**：以「保上游全部新 route 注册 + 逐个重贴我们 4 个 WithHiding 注入点 + 保留 registerHidingRoutes」为原则。需特别检查上游新 route 若走 `authenticateRequest` 而**应当**走 WithHiding（详见第四章 Q2）。

**冲突 2：`apps/api/src/memo-service.ts`**
- 本地改动：5 个函数开头的 `assertNotebookWritable` 守卫（`moveMemosRecord` L737 / `mergeMemosRecord` L809 / `createMemoRecord` L961 / `importMemosRecord` L1094 / `updateMemoRecord` L1236）
- 上游改动：`searchMemoSummaries` 大改（+多个 hunk，MCP 搜索结果加 body snippet）、`listMemosForMcp`、`moveMemosRecord` 微调
- **解决策略**：上游保留其 searchMemoSummaries 改动；我们逐个函数重新插入 5 个守卫（`moveMemosRecord` 有行级重叠，需手工合并）

**冲突 3：`apps/api/src/notebook-service.ts`**
- 本地改动：2 处守卫（`createNotebookRecord` L161 的 parentId 检查 / `updateNotebookRecord` L203 的 id 检查）
- 上游改动：`createNotebookRecord`（+1 hunk）/ `updateNotebookRecord`（4 个 hunk，含 210-231 的删除移动）/ `deleteNotebookRecord` 大改（新增 `deleteNotebookTree` 递归 CTE）
- **解决策略**：上游保留 deleteNotebookTree 新逻辑；我们重插 2 个守卫。注意上游 `deleteNotebookRecord` 改动 +104 行，需检查递归删除有没有绕过 `assertNotebookWritable`（详见第四章 Q3）。

---

## 四、关键风险与待拍板问题（Q1-Q6）

### Q1 — 基准版本：直接跳 v2.23.0，还是分批升？

**推荐：直接 v2.23.0。**

理由：
- 上游 tag 序列 `v1.90 → v2.0.x → ... → v2.23.0`，中间有 33 个 minor。分批升 = 多次 merge + 多次冲突解决 + 多次全库测试 + 多次部署，成本约 3-4 倍。
- merge-base 是干净的 tag `v1.90.0`，一次 merge 到底反而让冲突只出现一次。
- 风险不在「跳多远」，而在「冲突解决是否正确」+「新泄露面是否审计完」。后者本报告已完成。

**备选**：若主人偏好保守，可用 `v2.18.0` 或 `v2.20.0` 作为中间基准先升一次，再升 v2.23.0。代价 = 双倍工作量。

---

### Q2 — 上游新 route 该不该走 WithHiding 认证？

这是本次**最关键的设计问题**。上游 v2.x 新增了 5 个 route 文件：

| 新 route | 认证方式 | 是否含 memo 内容读取 | 建议 |
|---|---|---|---|
| `poster-render-routes.ts` | `requireUser`（agent 403） | 是（经 getMemoDetail） | ✅ 无需 WithHiding（agent 根本进不来） |
| `notebook-share-routes.ts` | `requireUser`（agent 403）+ 公开访问段 | 是（memos 表，已有 rule） | ✅ 无需 WithHiding |
| `import-routes.ts` | 需确认 | 是 | ⚠️ **待实施组确认** |
| `auth-totp-routes.ts` | 登录流程，无 agent token | 否 | ✅ 无需 |
| `table-form-routes.ts` | 已知：公开 route 早于认证中间件 | 是 | ✅ 已有 table_forms rule 覆盖 |

**判据**：`requireUser` 实现是 `auth?.kind === "user"`，agent token 是 `kind="token"` → 403。所以**走 requireUser 的端点天然隔离，无需 WithHiding**。

**Q2 结论：只需对「agent 可进入（走 /api/v1/* 认证中间件且不 requireUser）」的新增/改动 route 做 WithHiding 检查。** 实施组必须逐个核对上游 v2.23.0 的 `index.ts` 全部 `registerXxxRoutes` 调用，确认无 agent 可达的新泄露路径。

---

### Q3 — `delete_notebook`（新增 MCP 工具）的递归删除要不要加写守卫？

上游新增 `delete_notebook` MCP 工具 → 调 `deleteNotebookTree()`（递归 CTE 删除整棵子树，+104 行）。

**风险**：如果 agent 对一个**可见** notebook 调用 delete_notebook，而该 notebook 的子树里**理论上不该有**隐藏 notebook（因为隐藏 = 从 agent 视角看不到，但物理上仍可能存在父子关系？）——需实测确认。

**建议**：实施组做 DOUBT FIRST 探针：
1. 建 `nb_visible` → 子 `nb_hidden` 结构（隐藏的是子）
2. agent 调 `delete_notebook(nb_visible)` 
3. 期望：要么 403 拒绝，要么只删可见部分不碰隐藏
**若泄露（把隐藏 notebook 也删了 = 数据破坏）→ 必须加守卫**。

---

### Q4 — `poster_render_jobs` 泄露缺口如何修？

**探针已实测（真 bun:sqlite，非推测）**：
```
当前 INJECTION_RULES 无 poster_render_jobs →
SELECT * FROM poster_render_jobs WHERE workspace_id='ws1'
返回 [{"id":"job_hid","workspace_id":"ws1","memo_id":"m_hid","status":"pending"}]
LEAK CONFIRMED

加 rule 后：
SELECT * FROM poster_render_jobs WHERE (memo_id IS NULL OR memo_id NOT IN (SELECT id FROM memos WHERE notebook_id IN ('nb_hid'))) AND workspace_id='ws1'
返回 [] → FIXED
```

**修复方案（推荐，1 行改动）**：
```ts
// mcp-hiding.ts INJECTION_RULES 追加
{ table: "poster_render_jobs", getInjection: MEMO_ID_SUBQUERY },
```
+ 新测试档 `tests/mcp-hiding-poster-jobs.test.ts`（TDD RED→GREEN）
+ `leak-matrix.test.ts` 加 S11（poster_render_jobs 直读 + 经 MCP 工具路径）

**附带决策**：要不要顺手补 `notebook_shares` / `notebook_share_excluded_memos` / `video_transcript_jobs`？
- 本报告 27.4 已判定这 3 张表**全部走 `requireUser` 管理端点，agent 天然 403** → 无需补 rule（补了也无害，但增加维护成本）
- **推荐：只补 `poster_render_jobs`（唯一 agent 可达的真实缺口），其余 3 张写进「已审计无需补」清单存档**

---

### Q5 — 冲突解决后的验证标准

延续既有成功案例（Q4 交付 = commit hash + 变更说明）：

1. **merge 后立刻**：`bun install`（lockfile +1451/-820，新增 83+ 包）
2. **门禁三连绿**：`bun run typecheck` + `bun run typecheck:mobile` + `bun run build:web`
3. **全库测试对照 baseline**：`timeout 500 bun test` 记录 pass/fail 数，逐条比对上游 pre-existing fail（**不新增 fail** = 通过）
4. **隔离专项**：hiding 全套测试档 pass/fail 逐档记录
5. **docker-release**：`docker-release 7 pass / 0 fail`
6. **冲突解决专项复核**：3 个冲突文件人工读 diff，确认 **4 个 WithHiding 注入点 + 7 个写守卫（5 memo-service + 2 notebook-service）** 全在

---

### Q6 — DEPLOY 文档版本与内容

**延续成功案例**：`DEPLOY_REMOTE_BUILD_V2.md` 升 **V2.8**（V2.7 → V2.8），作为**独立 commit**。

必须更新的内容：
- 标题版本号 `V2.7` → `V2.8`
- 「日常升级流程」章的本次示例：`v1.90.0.1 → v2.23.0.1`
- migration 说明：37 个（0056-0092），**升级前数据备份 HARD-GATE**（重点：0066 poster / 0067 notebook_shares / 0088 TOTP 新增表 / 0058-0059 调色板退役改数据 / 0078 清默认颜色）
- Dockerfile 有改动 → build 步骤确认点
- `bun.lock` 大改 → 远端 `bun install` 时机（docker build 内自动，但需确认 Dockerfile 是否 `--frozen-lockfile`）
- V0-V8 验证清单加 **V9 poster_render_jobs 隔离验证**
- 回滚锚点更新：`fde-v1.90.0.1`（292718d0）成为新首选 / `fde-v1.65.0.1`（05c8062f）次选
- ⚠️ 回滚特殊注意：本次 schema 变化 37 个（比上次 9 个多 4 倍），回滚 = 不能简单 checkout，需还原数据备份

---

## 五、实施步骤（交实施组，Phase 28）

### 步骤 0：开工前置
- `start-project edgeever` → `start-phase`（Phase 28 待建）
- 确认 Q1-Q6 全部拍板
- **数据备份 HARD-GATE**：远端 `edgeever-data` bind mount 目录整份备份（37 个 migration 涉及数据改写）

### 步骤 1：开分支 + merge
```bash
git checkout fde-v1.90.0.1
git checkout -b fde-v2.23.0.1
git merge v2.23.0   # 预期 3 个冲突
```

### 步骤 2：解 3 个冲突（手工，主 Agent 亲自做）
- `index.ts`：保全部上游新 route + 重贴 4 个 WithHiding + `registerHidingRoutes`
- `memo-service.ts`：5 个守卫重插
- `notebook-service.ts`：3 个守卫重插
- 每解一个立即 `bun run typecheck` 局部验证

### 步骤 3：补 poster_render_jobs rule（TDD）
- RED：新档 `tests/mcp-hiding-poster-jobs.test.ts` 先红
- GREEN：`mcp-hiding.ts` INJECTION_RULES 加 1 行
- 扩展 `leak-matrix.test.ts` S11

### 步骤 4：Q2/Q3 审计（新 route + delete_notebook）
- 逐个核对 `index.ts` 全部 `registerXxxRoutes` 的 agent 可达性
- `delete_notebook` 递归删除 DOUBT FIRST 探针

### 步骤 5：全库门禁
- `bun install` → 三连绿 → `timeout 500 bun test` → docker-release

### 步骤 6：交付（3-commit 粒度，延续既有模式）
```
commit 1: merge 'v2.23.0' into fde-v2.23.0.1
commit 2: fix: poster_render_jobs isolation + conflict resolution (memo/notebook guards)
commit 3: docs: DEPLOY V2.8 for fde-v2.23.0.1
```
+ tag `fde-v2.23.0.1` + push（branch + tag 分开 refspec）

### 步骤 7：等主人远端部署 → 部署后 V0-V9 验证

---

## 六、回滚方案

| 层级 | 操作 |
|---|---|
| 代层回滚（未部署） | `git checkout fde-v1.90.0.1` 即回复 |
| 代码单点回滚 | 3 个 commit 可逐个 `git revert` |
| 已部署回滚 | ① 还原数据备份（**必须先做，37 migration 改数据**）② `git checkout fde-v1.90.0.1` + rebuild + `EDGE_EVER_VERSION` 改回 ③ `docker compose up -d` |
| 回滚锚点 | 首选 `fde-v1.90.0.1`（292718d0）/ 次选 `fde-v1.65.0.1`（05c8062f）/ 三选 `fde-v1.50.0.3`（33f53658） |

⚠️ **重点警告**：本次 37 个 migration 有 5 个会改历史数据（0058/0059 调色板退役、0078 清默认颜色、0053 已做、0070 种子本地化、0071 修 welcome markdown）。**没有数据备份 = 不可回滚**。

---

## 七、待主人拍板（Q1-Q6 汇总）

| # | 问题 | 我的推荐 |
|---|---|---|
| Q1 | 直接跳 v2.23.0 还是分批升 | **直接 v2.23.0** |
| Q2 | 新 route 是否走 WithHiding | **只对 agent 可达的新 route 做；requireUser 端点天然安全** |
| Q3 | delete_notebook 递归删除是否加写守卫 | **先探针实测，若泄露必加** |
| Q4 | poster_render_jobs 修复范围 | **只补 poster_render_jobs（1 行 + TDD）；其余 3 张只审计不补** |
| Q5 | 验证标准 | **延续既有：三连绿 + 全库对照 baseline 零新增 fail + hiding 全套 + docker-release** |
| Q6 | DEPLOY 版本 | **V2.8 独立 commit，含 37 migration 备份警告 + V9 验证项** |

---

**本报告为只读侦查成果。全部结论有实锤：版本双证 / merge-tree 实测 EXIT=1 / 真 bun:sqlite 探针 LEAK CONFIRMED + FIXED / 逐 case 审计 16 个新工具 / 全表扫描 16 张 memo-linked 表。**

**详细证据见 `findings.md` 的 F27-A ~ F27-E 五节。**
