# Task Plan: EdgeEver 项目（fde-v1.64.0.1 — 上游 merge v1.64.0 + MCP ping handler）

## Goal
**项目总目标**：EdgeEver fork（当前基准 fde-v1.64.0.1，HEAD=ce044488）持续演进。**现行焦点 = Phase 20 edgee-mcp skill v1.4.0 实施**（实施组：最终确认 Phase 19 方案 V2 → 主人批准 → patch skill + 2 个 reference）。Phase 19 分析调研已完成（diagram 三 kind 全 MCP 支持，方案 V2 定稿）。Phase 18 验证已 V0-V6 全 PASS，遗留 V7/V8 属测试组交接事项（见 Current Phase 遗留交接块）。回滚锚点：tag fde-v1.50.0.3（33f53658）。

### Current Phase
**▶️ Phase 20 edgee-mcp skill v1.4.0 实施（实施组 AI 负责）— 项目已暂停，等主人激活**
**🔮 触发语：主人话「edgee-mcp 升级实施组开工」。你嘅第一件事（按顺序）：**
**① registry start-project edgeever → ② read_file 本档 Current Phase + Phase 20 全部子步 → ③ 读交接文档 /home/hermes/.hermes/docs/edgeever-v19-handoff-mcp-skill-upgrade.md → ④ 由 20.1 最终确认清单开始，严格按顺序执行。**
**⚠️ HARD-GATE：20.1 最终确认全绿 → 报主人 → 主人明确批准后先准 patch skill 本体。**

**🎯 任务背景**：Phase 19 分析组已完成 MCP diagram 调研（findings D1-D4 源码实锤）+ WGS 标准升级方案 V2 定稿（/home/hermes/.hermes/docs/edgeever-v164-mcp-skill-upgrade-proposal-v2.md，含写死模板/pointer 四件套/实施清单/可选探针）。实施组第一任务 = **独立最终确认**（防转录漂移：源码 spot-check + 模板对 schema），确认完报主人批准先动手。
**📌 遗留交接（本组唔执行，除非主人另有指示）**：Phase 18 测试组 V0-V6 已全 PASS 后暂停；V7（24h keepalive 观察 2026-09-11 21:10 后查 errors.log + 清理 DZ_TEST_* 台账）+ V8 收尾属测试组遗留，完整交接块喺 progress.md 尾段；DEPLOY_REMOTE_BUILD_V2.md V2.5 改动未 commit，等主人指示。

**🔒 测试组负面清单（MASTER 钦定边界）**：
- **唔准改代码**：任何 bug 发现 → 调查 → 写 findings → 报 MASTER，唔准自己 patch 唔准开分支
- **唔掂主人现有笔记数据**：所有写操作测试只用 DZ_TEST_* 新建数据，测完即清，终态对照开测前快照
- **唔准远端部署/回滚动作**：部署由主人做；发现问题报 MASTER 决策
- **唔准删旧分支/tag/data volume**；唔准 curl 第三方站（MCP 工具 + /api/health 本机查询除外）
- **唔好删本地旧分支**：fde-v1.50.0.x 分支/tag 全部保留（回滚锚点）
- **远端验证优先只读**：先 MCP 读操作 → 再 REST 读 → 再写操作（写需逐项确认）

**⚠️ 测试组必读（Phase 16 实测教训，写呢份 plan 时已整合，执行时唔好再踩）**：
- **V3 stats**：Phase 16 实测 stats 有隔离过滤（agent 见到嘅 stats= 可见数）= **PASS 判定**，唔好当 bug 报（Phase 12 era「全局计数」记录已过时）
- **DELETE 隐藏分类 → 404 not_found 係隔离设计**，唔係 bug（隔离哲学：连存在性都唔暴露）；正确镜像测试 = DELETE **可见**空分类应 200
- **delete_tag 返 updated:0 唔等于失败**（tag 绑住回收站/隔离视野外 memo 时 agent 视野冇嘢可改）
- **清理顺序**：trash 测试 memo → DELETE 测试分类（REST /api/v1/notebooks/:id）→ REST /api/v1/memos/:id?permanent=1 永久删 → 再 delete_tag 复核；**终态核验对照开测前第一次 stats 快照**，唔靠估
- **工作模式**：整体串行 + 效率型批量并行（无依赖只读项一批过；V0 闸门 fail-stop → 后续全部依赖佢，必须先过）

**REMOTE 访问方式（Phase 16 实战惯例）**：MCP 用 `mcp__edgee__` 工具（Hermes 已连接远端 EdgeEver 实例）；REST 用同一 api_token（从 ~/.hermes/config.yaml 用 python regex 抽 eev_[A-Za-z0-9+/=_-]+）打远端 /api/v1/ 端点；gateway log 睇 keepalive 行为（~/.hermes/logs/agent.log + errors.log）。

---

## Phases
<!-- llm-hook 注入窗口 = 本文件头 80 行。规则：新 Phase 必须加喺 NEW PHASES INSERT HERE 下面（唔好加文件底部）；窗口内先放「待完成」Phase，完成嘅移到窗口外后面存档，令未完成工作永远可见 -->

<!-- NEW PHASES INSERT HERE-->

### Phase 19: MCP 技能分析和升级方案（分析组 AI 负责）— diagram 图形笔记为重点
- [x] **19.1 codebase-cli moderate 索引 — ✅ PASS（2026-09-10 实测，索引已新鲜唔使重索引）**：① list_projects 发现 home-hermes-workspace-edgeever 已系 fde-v1.64.0.1 分支 head_sha=**ce044488fd8504f06933d00f61a33f79fe548542** = git HEAD **完全匹配** ✅；② 8765 nodes / 25217 edges（vs 旧 v1.50.0 基线 8627/25077，+138/+140 = v1.64.0 变化已入图谱），体量同 moderate 模式一致（实施组 Phase 17 后已重索引）；③ 按新鲜度铁律（head_sha == HEAD = 新鲜）**唔重索引，省资源**；④ 后续调研直接用呢个索引
- [x] **19.2 MCP diagram 三工具深度调研 — ✅ 完成（2026-09-10）**：三工具 schema + 服务端实现全读（mcp-tools.ts L97-261 / mcp-tool-service.ts L203-620+706-775 / diagram.ts / diagram-layout.ts）；三 kind = mind-map/flowchart/architecture 全 MCP 支持；findings D1-D2 全参数实锤（per-kind 白名单 / 46 resourceIcon / theme 14 / structure 13 / update 六 operations / reflow preserve 语义 / 乐观锁）
- [x] **19.3 Web 端三种图形类型对照 — ✅ 完成（代码级对照，无需写探针）**：主人三种图形（架构图/流程图/思维导图）↔ MCP kind=architecture/flowchart/mind-map 一一对应，能建能读能改全支持（Phase 18 V4 已实测 create+读回成功佐证）；唔支持项：flowchart 禁 parentId、boundary 禁做 edge 端点、resourceIcon 仅 architecture（findings D1）；structure 参数 flowchart/architecture 会存但 layout 忽略（diagram-layout.ts L435/L853）→ skill 指引净 mind-map 用
- [x] **19.4 v1.64.0 其他新功能扫描 — ✅ 完成**：MCP 工具面净 +3 diagram（旧 42 schema 零变化）；get_memo 自动附 diagram + update_memo 禁改 diagram（新行为）；plugins/multipart/scheduled/companion 评估完毕（findings D4：plugins 无 MCP 工具、附件走 REST、scheduled/companion 暂无用）
- [x] **19.5 发现记录 findings.md — ✅ 完成**：Phase 19 章 D1-D4 已写入（带文件行号来源）；FTS 对 diagram fallback markdown 搜索覆盖标「待实测探针（需主人批准先做）」
- [x] **19.6 edgee-mcp skill 升级方案草稿 — ✅ 完成（2026-09-10）**：草稿存 /home/hermes/.hermes/docs/edgeever-v164-mcp-skill-upgrade-proposal.md（新增 Diagram 整章：参数速查/三 kind 规则矩阵/4 个 ready-to-use 用例/6 条 pitfalls + 7 项既有章节修订 + 验证计划 + 风险边界）；⚠️ HARD-GATE 生效中：等主人批准先 patch skill 本体
- [x] **19.7 汇报主人 — ✅ 完成（2026-09-10）**：两轮汇报已发（D1-D4 发现汇报 + WGS 重设计方案 V2 汇报）；主人裁决：方案 V2 落项目文档 + 移交实施组最终确认 + 项目暂停。分析组任务终结。
- **Status:** ✅ complete（2026-09-10 分析组终结；19.6 升级为 V2 定稿版存放 docs/，实施移交 Phase 20）

### Phase 20: edgee-mcp skill v1.4.0 实施（实施组 AI 负责）— 待主人激活
- [ ] **20.0 激活条件**：主人话「edgee-mcp 升级实施组开工」→ ① registry start-project edgeever → ② 读 task_plan 本 Phase + 交接文档 → ③ 由 20.1 开始
- [ ] **20.1 最终确认（第一任务，顺序过）**：① 读方案 V2 全文（/home/hermes/.hermes/docs/edgeever-v164-mcp-skill-upgrade-proposal-v2.md）+ findings.md Phase 19 章 D1-D4；② 读 edgee-mcp SKILL.md v1.3.0 全文核对结构；③ mtime 复查（早过 2026-09-10 = 安全；新过 = 有其他 session 改过 → 停手报主人）；④ 源码 spot-check 3 处（mcp-tools.ts L97-261 / mcp-tool-service.ts L270、L312-340）防转录漂移；⑤ 模板参数逐字段对返 schema（尤其 enum 拼写）；⑥ 全绿 → 报主人「最终确认完成」等批准
- [ ] **20.2 实施（主人批准后）**：按方案第 7.7 顺序 —— cp 备份 → 主技能 4 处 patch（新增 Diagram 章 4.1-4.6 写死内容 + description 触发词 + 防呆表 +1 行 + dryRun 矩阵 +1 行 + 版本 v1.4.0）→ write_file 两个 reference（diagram-cookbook.md / diagram-editing.md，素材转录 findings D1-D4）→ 重读衔接验证 → skill_view 复核
- [ ] **20.3 可选探针**：主人批准先做（方案第 8 章：三模板实测 + update 闭环 + FTS 验证，DZ_TEST_* 测完即清）；主人话唔使就跳过
- [ ] **20.4 收尾**：task_plan Phase 20 标 complete + progress.md 实录 + registry stop-project（completed 或 paused 按主人指示）+ 报主人验收
- **Status:** pending（等主人激活实施组；⚠️ HARD-GATE：主人批准前唔准 patch skill 本体唔准开 reference 文件）

### Phase 18: fde-v1.64.0.1 远端功能验证（测试组 AI 负责）— V0 到 V7
- [x] **18.0 V0 部署闸门 — ✅ PASS（2026-09-10 测试组实测，含 hash 预期值修正，MASTER 已裁决）**：① GET /api/health → "ok":true ✅ + migration="0046" ✅ + build=**143866584b75**（原预期 ce044488fd85；实测为 pre-amend docs commit —— MASTER 2026-09-10 确认：143866584b75 = 实施组最后构建基准，与 ce044488 代码完全相同（diff 仅 DEPLOY_REMOTE_BUILD_V2.md 49+/13-，零代码差异），文档以最新 ce044488 为准，预期值据此更新 → V0-① PASS）；② 启动日志 11 行 applied migration：测试组无 SSH 通道直接睇远端日志，以 /api/health migration=0046（数据库 schema 实况）作间接实锤 = 11 个 migration 已全部应用；③ docker compose ps：无 SSH 通道唔能直接验证，容器服务正常响应 /api/health 本身为间接证据。MASTER 指示：继续按计划进行 V1+。
- [x] **18.1 V1 MCP 工具注册 — ✅ PASS（2026-09-10 21:03 实测）**：agent.log 20:44:35 部署后 re-register 记录 = **45 tool(s)**（42→45 ✅）；create_diagram_memo / get_diagram / update_diagram 三个 diagram 工具全部出现；原有 42 个逐一名单比对无缺失。tools/list 名单完整存 progress.md。
- [x] **18.2 V2 keepalive ping 实锤 — ✅ PASS（2026-09-10 21:10 实测，部署后 26 分钟窗口）**：① keepalive 周期已过多个周期；② agent.log 部署后窗口见 POST /mcp 200 OK 正常行（20:44:06 起连续）；③ errors.log 部署后（20:44:35 后）零「keepalive failed」零新增 -32601（旧版本模式部署后 3 分钟内必现「does not implement ping」，本次 26 分钟零记录 = ping handler 生效实锤）；④ 最后一次「does not implement ping」停喺 2026-09-08 旧版本时代（latch 旧记录唔算 fail）。V2 终极确认留 V7 24h 观察。
- [x] **18.3 V3 隔离回归 — ✅ PASS（2026-09-10 21:19-21:33 实测，主人已加隔离）**：① MCP 写隐藏分类 → 403 restricted ✅（REST 同路径 → **500 internal_error**，见 findings 缺口记录，非阻断 finding）；② get_memo 隐藏 → not_found ✅（MCP+REST 双通道；includeDeleted=true 都绕不过 = 隔离 bypass-proof ✅）；③ list_notebooks 隐形 ✅（8→6）；④ list_memos 隐形 ✅（两条隐藏载体完全消失，可见载体照常）；⑤ search 标记字串 → 零结果 ✅（双标记验证）；⑥ stats 过滤 ✅（active=17=可见数；trashed 6→7 / tags 59→57 经 REST 对账 = 主人自己 Web 端动作「AI 功能测试笔记」trash + 架构图/流程图/思维导图测试，账目分毫不差唔係隔离机制问题）；⑦ list_tags 隐藏内容零出现 ✅（dz-test-164-r1 因唯一绑定 memo 被隔离而整体隐形 = 正确语义）；⑧ list_memo_revisions 隐藏 memo → REST 404 ✅；⑨ find_notebooks 隐藏名唔命中 ✅
- [x] **18.4 V4 diagram 隔离探针 — ✅ 全部完成（2026-09-10 21:19-21:35 实测）**：① create_diagram_memo 隐藏分类 → 403 restricted ✅（第一次参数传多 contentMarkdown 报 unsupported 属测试脚本错误唔算结果，修正后实测 403）；② 可见分类创建+读回 ✅（早前完成）；③ get_diagram 隐藏 memo → not_found ✅；④ search「HIDDEN-DGM」→ 零命中 ✅；⑤ update_diagram 隐藏 memo（expectedRevision=0 + add_node）→ **Memo not found** ✅（连存在性都唔暴露）；⑥ get_memo 对照 → not_found 语义一致 ✅。**V3+V4 全部 15 项隔离探针 PASS，新工具完全接入隔离体系**
- [x] **18.5 V5 BUG 四连回归 — ✅ 全过（2026-09-10 21:08-21:10 实测）**：① BUG-001：search_memos query="EdgeEver deployment docker" 正常返回空结果数组（唔报 ambiguous column name: memo_id）✅；② BUG-002：create_notebook("DZ_TEST_NB") 成功返回 nb_7904d0c44e44404db7a91a73d399e049 + list_notebooks 见到空分类 ✅；③ BUG-002 镜像：REST DELETE 可见空分类 DZ_TEST_NB → HTTP 200 {"ok":true}，find_notebooks 复核已消失 ✅；④ BUG-003：rename_tag dz-test-164 → dz-test-164-r1 返 {"ok":true,"updated":1,"verified":true,"remainingOldTag":0}，list_tags ground truth 复核：dz-test-164-r1 存在（memoCount=1）旧 tag 消失 ✅（Phase 16 教训：唔信 ok:true，必验 list_tags）
- [x] **18.6 V6 上游新功能 smoke — ✅ PASS（2026-09-10 21:11 实测）**：① multipart 上传实测两连：12MB 档 → HTTP 201（res_cfbce20aac7c4ab7af5afbb23f7d228d）+ 60MB 档（>50MB PLAN 要求）→ HTTP 201（res_f4e0fe05ec1a4c39b4aef236de0ea7a0）；GET /api/v1/resources 对账 totalCount=2 totalBytes=75497494（12,582,930+62,914,564 分毫不差）attachmentCount=2 ✅（0036_resource_multipart_uploads 功能实锤）；② scheduled tasks/companion：45 工具注册无异常、全批 MCP/REST 调用零错 = 不影响现有工具行为 ✅（唔深测，主人未要求启用）；③ Web 端 diagram 渲染：**建议主人自己开 Web 睇一眼 DZ_TEST_DGM 分类嘅「DZ_TEST_DGM_MAP_V164」**（AI 唔验证，主人验收项）
- [ ] **18.7 V7 24h 观察 + 清理**：① 24h 后 errors.log 确认零 keepalive failed（ping 根治终实锤）；② 清理全部 DZ_TEST_*（顺序见上面必读块）；③ 终态 stats 快照对照开测前快照（tags.active 允许固有回收站 +1 差值，Phase 16 实锤）
- [ ] **18.8 收尾**：全过 → 本 Phase 标 complete + 写 findings 实测差异 + registry stop-project completed + 报 MASTER 验收；任一失败 → 停手，调查 → findings.md → 报 MASTER（唔准改代码唔准回滚）
- **Status:** V0-V6 全 PASS（2026-09-10）；V7/V8 pending = 测试组遗留，交接块喺 progress.md 尾段（本组唔执行，除非主人另有指示）

### Phase 17: fde-v1.64.0.1 实施（⏳ COMPLETED 2026-09-10 —— 实录移到文件尾存档区；测试组唔使理会本章）
- [x] 17.1-17.9 全部完成（逐步实录 + 关键决策见文件尾「⏳ 历史存档：Phase 17 实施实绩」章）
- **Status:** ✅ complete（2026-09-10，最终 HEAD=ce044488，branch+tag fde-v1.64.0.1 已 push，主人已部署）

---

## 背景：版本事故（2026-08-31）
- v1.9.4 时代曾完成完整 PATCH（Phase 1-6，8 commits，40/40 测试），但后来发现**误信 `git tag -l` 末尾结果**以为 v1.9.4 系最新，真实 latest 已是 **v1.50.0**
- v1.9.4 → v1.50.0 跨 40+ 版本，架构巨变：index.ts 5877→920 行拆分成 ~20 个 service/route、新增 StorageAdapter 抽象层、AI 功能、FTS5 全文搜索、规范化标签表、官方 Dockerfile
- **决定**：v1.9.4 PATCH 作废，基于 v1.50.0 开全新分支 **fde-v1.50.0.1** 重新做 PATCH，功能目标不变。旧分支 fde-v1.9.4.1 保留参考

## 关键路径（⏳ 历史存档 2026-09-04 v1.50.0.3 era — 以本文件顶部 Current Phase 为准；环境/索引/工具事实仍有效）
- **开发仓库**：`~/workspace/edgeever`，**当前分支 `fde-v1.50.0.3`（HEAD=33f53658，工作树干净）**。旧分支 fde-v1.50.0.2 / fde-v1.9.4.1 / main 保留参考
- **远端部署状态**：✅ 主人已 BUILD + RUN v1.50.0.3（2026-09-04 确认）→ Phase 16 功能验证已完成 11/11（2026-09-04）
- **回滚锚点**：tag `fde-v1.50.0.3`(33f53658) = 现行稳定版首选 / `fde-v1.50.0.2`(2dfd30ac) / `fde-v1.50.0.1`(5ab893a6) 备用（3 个 tag 已推 GitHub）
- **只读基线仓库**：`~/workspace/edgeever-reference`（detached v1.50.0, commit 5ab7505c）—— 对照用，唔好郁
- **codebase 索引**：开发分支 = `home-hermes-workspace-edgeever`（8627 nodes/25077 edges = v1.50.0 基线，v1.50.0.3 改动未重索引，改动细节直接读 git diff）；只读基线 = `home-hermes-workspace-edgeever-reference`（8627/25094）。⚠️ moderate 排除 migrations/，schema 直接读 migrations/*.sql
- **探针存档**：`~/.hermes/docs/edgeever-v1.50.0.3/`（verified-patch.diff + 5 个 probe-*.ts）—— **实施已完成，呢批系历史证据，验证阶段用唔着**
- **技能**：edgeever-fork-development（开发者视角）、planning-with-files；⚠️ 验证阶段用 `mcp__edgee__` MCP 工具（用家视角），**冇 edgee-mcp skill 存在，唔好尝试 load**
- **环境（本地）**：`export PATH="$HOME/.bun/bin:$PATH"`；bun 1.4.0；node_modules 已在；全库 `timeout 500 bun test`；⚠️ `timeout 600 bun test` 会被 terminal 工具拒（前台 600s 上限）
- **⚠️ 呢节系 v1.50.0.3 era 存档**：Phase 16 已完成（11/11，2026-09-04）；Phase 17 实施亦已完成（2026-09-10）—— 现行任务睇文件顶部 **Phase 18（测试组）**
- **⏳ 旧指引（已执行完毕 2026-09-04，勿再执行）**：Phase 16 远端功能验证 11/11 全过；Phase 16 全章只作台账参考，现行任务睇文件顶部 Phase 18

---

## ⏳ 历史存档：旧 Phases 记录（Phase 1-16，v1.9.4 → v1.50.0.3 era，全部完结）

### Phase 1-6: 旧基线 v1.9.4 实施（已作废，仅保留参考）
- 完整记录见本文件 git 历史（分支 fde-v1.9.4.1，commits 1a1b64b2→6c07fc0a）
- **可复用资产**（概念，唔可直接 cherry-pick，架构全变）：mcp-hiding.ts 确定性 SQL 词法解析器、递归 CTE 继承、fail-closed 原则、TokenHidingEditor 树状选择器交互、全库 SQL 安全网测试模式
- v1.9.4 spec：docs/superpowers/specs/2026-08-28-mcp-notebook-hiding-design.md（部分已被实施取代，仅参考）

### Phase 7: v1.50.0 重新基准调研（COMPLETED 2026-08-31）
- [x] Reference 仓库确认 v1.50.0（commit 5ab7505c，release-summary.json 佐证）
- [x] codebase MODERATE 索引完成（8627/25094）
- [x] 架构调研：StorageAdapter 抽象层、认证流、MCP 路由、8 张内容表、AI 泄露面、Bun 单例
- [x] findings.md 落盘
- **Status:** complete

### Phase 8: v1.50.0 方案定案（COMPLETED 2026-08-31，MASTER 批准）
- [x] 8 议题全部拍板（详见下方「定案」章节）
- [x] 边界验证：requireOwner 现成、公开分享路由无泄露、Bun 单例并发安全
- [x] PWF 三文件更新（本文件 + findings + progress）
- [x] Handoff 交接文档生成（/tmp/handoff-F7wQDg.md）+ 主人复制版上手 prompt
- **Status:** complete

### Phase 9: v1.50.0 实施（COMPLETED 2026-09-02，全部 9.2-9.10 完成 + Docker 交付）

**已完成（2026-09-02）**
- [x] **9.0 Git 基线重建**：基于 tag v1.50.0 开 fde-v1.50.0.1
- [x] **9.1 codebase MODERATE 索引**：8627 nodes / 25077 edges
- [x] **9.1.5 定案逐项验证**：V1-V12 全部源码核实 + 2 处修订
- [x] **9.2 Spike**（commit 9f1d8c39）：env clone 并发隔离 / batch unwrap / 8 表注入 fail-closed（13/13 pass）
- [x] **9.3 Migration**（commit 2af6e7d3）：0036_mcp_token_hidden.sql + 递归 CTE + CASCADE 测试（6/6 pass）
- [x] **9.4 HidingDatabaseAdapter**（commit ad43bb3a）：确定性 SQL 词法解析 + 8 表覆盖 + FTS 双保险 + fail-closed + batch unwrap（27/27 pass）
- [x] **9.5 认证注入**（commit 163a791f）：fetchEdgeEverApp env clone + authenticateRequestWithHiding 4 调用点（9/9 pass, typecheck green）
- [x] **9.6 写入守卫**（commit da9db988）：hiding-guards.ts + 7 个 Record 函数前置 guard（7/7 pass, typecheck green）
- [x] **9.7 管理端点**（commit f8e1d308）：hiding-routes.ts GET/PUT + requireOwner（8/8 pass, typecheck green）
- [x] **9.8 前端**（commit 47f70cf4）：TokenHidingEditor 树状选择器 + i18n 中英同步（typecheck + typecheck:mobile + build:web 全绿）
- [x] **9.9 验收 BUILD 前硬 GATE**（commit 5ab893a6）：泄露矩阵 7 场景 + 三连全绿（13/13 pass, 235 pass / 5 pre-existing fail）
- [x] **9.10 Docker 交付**：docker build → edgeever-fde-v1.50.0.1.tar.zst（169MB, zstd -t 校验通过）→ docker rmi 删 image
- [x] **DEPLOY 文档**：DEPLOY_V1.50.0.1.md（版本摘要 + 部署 7 步 + 回滚方案 + 架构要点 + 安全审计 + 远端实机测试 checklist）
- **Status:** complete — 等待远端实机测试反馈

---

## 定案（Phase 8 — MASTER 2026-08-31 批准）

**PATCH 总原则**：统一、好管理、简单维护、安全、唔破坏原有功能。

1. **Wrapper 层级**：HidingDatabaseAdapter **只包 db**（DatabaseAdapter 的 prepare/batch）；storage 的 blob resources、diagnostics 原样透传。附件 blob 唔使包（resource 行经 db JOIN memos 已被拦，agent 攞唔到隐藏附件 id）。
2. **注入点**：index.ts 定义 `authenticateRequestWithHiding`（调原 authenticateRequest → auth.kind==="agent" && tokenId → 加载该 token 隐藏集合 → 每请求替换 `c.env.storage` 为包咗 hiding db 的 storage）。4 个调用点统一换：/api/v1/* middleware（index.ts:273）、registerAuthRoutes deps（227）、registerUserRoutes deps（242）、registerMcpRoutes deps（339）。**auth-service.ts 零改动**（上游零冲突）。
3. **SQL 过滤**：移植 v1.9.4 验证过嘅确定性词法解析器（唔用正则）+ 表别名白名单 + **fail-closed**（SELECT 触及内容表但解析唔到注入点即抛错，唔静默放行）。
4. **内容表清单（8 张）**：notebooks(n.id)、memos(m.notebook_id)、memo_contents(JOIN memos)、memo_revisions(JOIN memos)、resources(JOIN memos)、**memo_search_documents**(memo_id, 0034)、**memos_fts**(FTS5 虚拟表 memo_id, 0034)、**memo_tags**(memo_id, 0035)。
5. **FTS5 拦截**：memos_fts 查询直接注入 `memo_id NOT IN (SELECT id FROM memos WHERE notebook_id IN ...)`（FTS5 UNINDEXED 列支持 WHERE），唔靠下游 JOIN 兜底；COUNT 查询同样要过滤。
6. **写入守卫**：INSERT/UPDATE/DELETE 唔改写，共享写入守卫前置，agent 写隐藏分类→403 明确文案。写入点实施阶段用全库 SQL 安全网枚举。
7. **管理端点**：hiding-routes.ts，`/api/v1/api-tokens/:id/hiding` GET/PUT，用上游现成 **requireOwner**（request-auth.ts:33，kind==="user"&&role==="owner"；agent/member→403 防自解封）。
8. **前端**：McpConfigCard.tsx 内 token 列表下每个 token 可展开树状分类选择器（父勾选子孙继承）；i18n 文案在 packages/shared/src/i18n/{zh-CN,en-US}.ts。
9. **Migration**：**0036_mcp_token_hidden.sql**（上游最新 0035；旧 fork 0023 随旧基线作废）。表 mcp_token_hidden_notebooks，PK(token_id,notebook_id)，FK api_tokens(id) ON DELETE CASCADE。父隐藏→子孙继承用**运行时递归 CTE** 展开，唔冗余存储。
10. **Git**：加 upstream remote → fetch --tags → 基于 v1.50.0 开 **fde-v1.50.0.1** 全新 PATCH 分支；旧 fde-v1.9.4.1 保留参考。

**不变决策（v1.9.4 验证，沿用）**：per-token 隔离；session/网页/手机零影响（唔注入 wrapper）；disabled-auth 合成 owner 唔注入；stats 跟 token 可见范围计数（隐藏唔计入）；标签名全局共享唔算泄露，但 rename/delete 只影响可见笔记；读取隐藏对象统一 not_found 唔暴露存在性；写入隐藏分类 403 明确文案。

## 边界验证结果（2026-08-31）
- **requireOwner**：上游现成（request-auth.ts:33-38），错误消息原文「manage users」但前端用自己 i18n 文案，照用即可。
- **公开分享无泄露**：`/api/public/shares/:token` 凭随机 share token 公开访问，agent 读唔到隐藏笔记→攞唔到 share token→摸唔入；`/api/v1/memos/:id/share` 用 requireUser（agent 直接 403）双保险。
- **Bun 单例铁证**：scripts/self-hosted-server.mjs 启动时创建一次 `env={storage,...}`（~line 77），Bun.serve 所有请求共用 → **wrapper 必须每请求替换 c.env.storage，绝唔 mutate 共享单例**（并发 await 交错会串请求）。S3 backend 只系 blob，db 依然 sqlite adapter，包 db 一样适用。
- **batch pitfall**：self-hosted-storage-adapter.ts:76 batch() 有 `instanceof SqlitePreparedStatement` 检查 → wrapper batch 必须 unwrap 到底层 statement 再传，否则 TypeError。
- **AI 功能无泄露**：ai-routes/ai-service/ai-prompt-service 只碰 ai_workspace_settings/ai_provider_configs/ai_prompt_templates/ai_models，唔读笔记内容；tag suggestion 系网页 session 功能（requireUser），agent 行唔到。

## Key Questions
1. 实施 9.4/9.6 时：sync/backup/exports 全量端点 SQL 逐条审计（安全网测试输入）—— 待实施阶段枚举
2. McpConfigCard.tsx 具体结构 + notebook tree selector 挂载点 —— 9.8 时读代码确认

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| v1.9.4 PATCH 作废，v1.50.0 全新分支 fde-v1.50.0.1 | 跨 40+ 版本架构巨变，cherry-pick 唔现实；新分支历史清晰 |
| Wrapper 只包 db 唔包成个 storage | hiding 只管数据访问；blob 经 db 已拦，最小侵入 |
| 认证包装层注入，auth-service.ts 零改动 | 上游零冲突，dependencies 注入点现成 |
| 每请求替换 c.env.storage，唔 mutate 单例 | Bun 启动单例，并发安全 |
| migration 0036 | 上游最新 0035，递增编号 |
| 管理端点 requireOwner | 上游现成，agent/member 403 防自解封 |
| FTS 直接注入 memo_id NOT IN 子查询 | 唔靠下游 JOIN 兜底，fail-closed 一致 |

## Errors Encountered
| Error | Attempt | Resolution |
|-------|---------|------------|
| 误信 `git tag -l` 末尾=latest（实为 v1.9.4，真实 latest v1.50.0），导致成个 PATCH 基准过旧 | 1 | 用 reference 仓库锁定已知 good tag（release-summary.json 佐证）；未来确认 latest 用 `git ls-remote --tags` 或官方 release，唔靠 tag 列表末尾 |

## Notes
- 严禁修改已执行旧 migration；新功能加递增编号 SQL
- AGENTS.md：严禁开新分支（指上游 main 工作流）；我哋 fork 用 fde-vX.Y.Z.N 补丁分支系既定做法
- 验证命令：bun run typecheck + typecheck:mobile + build:web
- Bun 运行时已就绪：bun **1.4.0** @ ~/.bun/bin/bun（2026-08-31 验证，**唔使再装 bun**）；Hermes terminal 默认 PATH 唔含，每次先 `export PATH="$HOME/.bun/bin:$PATH"`；node_modules 未装（新分支干净），9.2 前喺仓库根 `bun install`（约 12s / 1971 包）
- 主人未发话前唔实施、唔写 spec；PWF 三文件已在 .git/info/exclude（唔入版本历史）

---

### Phase 10: BUG-001 search_memos 歧义修复（PENDING — 方案待主人批准）

**问题**：mcp-hiding.ts 对含 CTE 的 FTS 搜索 SQL 改写时，bare memo_id 注入落到外层 WHERE 产生歧义（"ambiguous column name: memo_id"），同时存在同表重复注入。远端 MCP search_memos 100% 报错，REST GET /api/v1/memos?query= 同中招。

**根因**：findTableRefs 收集全 SQL 表引用（含 CTE 内部）但 injectWhereClause 只在 depth-0 WHERE 追加 → CTE 内 FTS 表的注入条件落错位置。详见 findings.md「BUG-001」。

**推荐方案 A（按作用域注入）**：
- 10.1 findTableRefs 返回每个 table ref 的作用域（所在 SELECT 块），FTS bare memo_id 注入到 memos_fts 所在子查询的 WHERE，非全局 WHERE
- 10.2 同 (table, alias) 去重，禁止重复 AND
- 10.3 测试升级：用真实 searchMemoSummaries SQL 做 fixture，bun:sqlite 实测 rewritten SQL 可执行（不只 toContain）
- 10.4 验证：MCP search_memos + REST query= 远端复测 C3
- 影响面：只改 mcp-hiding.ts + 测试，上游零冲突

**Status:** pending（等主人批准方案后实施）

### Phase 10 更新（2026-09-02 主人拍板）

**方案 A 批准（按作用域注入），但不实施** — 本轮只做：bug 修复实施 + 部署模式切换记录，实施留给下个 session。

**部署模式切换（主人指示）：预 BUILD 镜像传输废弃**
- 旧方法：本地 build → tar.zst 169MB → scp → docker load（传输太慢，不可持续）
- 新方法：**远端 git clone / git pull → 远端 docker build**
- 分支 fde-v1.50.0.1（HEAD=5ab893a6）已推送 GitHub fork（已验证 ls-remote 一致）
- 教程：**DEPLOY_REMOTE_BUILD_V2.md**（clone → build → compose .env 指向本地镜像 → 日常升级 → Bun/Docker 残留清理 → 回滚）
- 关键点：docker build 全容器内多阶段，远端源码目录不应有 node_modules / bun cache（教程含体检脚本）
- 未来交付物 = commit hash + 简短变更说明，唔再交 tar

**Status:** 记录完成 — Phase 10 并入 Phase 11（fde-v1.50.0.2 新分支实施）

### Phase 11: BUG-001 修复实施（fde-v1.50.0.2 新分支，IN PROGRESS 2026-09-02）

**背景**：主人拍板 7 问 GRILL ME BATCH（Q1=A 集合计算豁免 / Q2=A notebooks-only 豁免 / Q3=真 SQLite 实跑升级 / Q4=baseline 对比 / Q5=doubt-first-check.ts 留低 / Q6=DEPLOY 升级 V2.1 / Q7=3 commit 粒度）。**v1.50.0.1 确认可用 → 打 tag fde-v1.50.0.1（5ab893a6，branch+tag 已推 GitHub）→ 开新分支 fde-v1.50.0.2 实施修复。**

**DOUBT FIRST 四连实锤（真 bun:sqlite 3.53.2 验证，脚本 tests/doubt-first-check.ts）**：
- D1 ✅：方案 A 目标产物（FTS MATCH 后 AND + 外层 m./c. 前缀）真 SQLite 执行成功 + 隔离语义正确
- D2 实锤：旧测试 fixture 引用未定义 CTE（no such table: search_matches）→ toContain 断言永远测唔出改写 bug
- D3 新 BUG（方案 A 原文未覆盖）：list_memos includeDescendants=1 嘅 recursive CTE（notebook_id IN (WITH RECURSIVE ... FROM notebooks)）→ 改写产物实跑 FAIL "no such column: notebooks.id"。CTE 内 notebooks 系集合计算用途，注入过滤落去语义就错
- D4 新 BUG（同样未覆盖）：isNotebookDescendant（move 防环检查）改写后同样 FAIL。树遍历 utility SQL 唔暴露内容行

**TDD 实施顺序（Iron Law：无失败测试唔写生产代码）**：
- [x] 11.0 PWF 落盘（本节）
- [x] 11.1 RED-1：tests/mcp-hiding-real-sqlite.test.ts 新测试（真 schema mock + 5 RED 断言）
- [x] 11.2 RED-1 验证全 FAIL（ambiguous ×3 + no such column ×2，失败原因全部正确）
- [x] 11.3 GREEN-1：mcp-hiding.ts 修复（作用域感知 + D3/D4 豁免 + 分组去重 + 块定位注入 injectWhereAtDepth）
- [x] 11.4 GREEN-1 验证：新 5 + 旧 83 = 88/88 全 PASS 零回归
- [x] 11.5 RED-2：leak-matrix S8(D3) + S9(D4) 回归场景（含写入守卫不弱化断言）
- [x] 11.6 GREEN-2：15/15 全 PASS（S8/S9 首跑即绿 = 回归守护）
- [x] 11.7 Q3 测试升级：旧 fixture 修正（DOUBT 2 自盲）+ 12 项真 SQLite sweep → 39/39
- [x] 11.8 全库 1200 pass / 8 pre-existing fail（与 baseline 完全一致）+ 三连全绿
- [x] 11.9 Q5：doubt-first-check.ts + repro-search-bug.ts 留低正式化（provenance headers）
- [x] 11.10 3 commits：670a7611 fix + 5275eec6 test + 2dfd30ac docs
- [x] 11.11 Q6：DEPLOY_REMOTE_BUILD_V2.md → V2.1（第零步体检 + dirty tree + hash 校验 + 升级验证重点，244 行）
- [x] 11.12 push fde-v1.50.0.2（远端验证 2dfd30ac 一致）+ PWF 最终状态 + 交付 DEPLOY 指引

**GREEN-1 实施过程中的关键决策（_patch 衔接检查实录）**：
1. TableRef 加 depth + tokenIndex + insideInSubquery（findTableRefs 扫描时记录 IN-subquery paren 栈）
2. 初版 D4 豁免太阔（all refs notebooks）→ 直接 SELECT notebooks 也被豁免 → 3 个旧测试回归失败 → 窄化为「depth 0 无 content 表 + content refs 全系 notebooks」（tree-walk only）
3. 初版流式 dedup bug：CTE 内 ref 先 add seen → 外层同 (table,alias) 被 skip → outerInjections 空（静默泄露风险）→ 改为分组式（RefGroup hasDepth0/minDepth/refTokenIndex，外层优先）
4. 初版 injectWhereAtDepth 按 depth 分组扫描 → UNION ALL 多块 WHERE 覆盖 bug（fragment 落错第二块 OR 链后）→ 重写为块定位算法（refTokenIndex 反向处理 + 逐目标 re-tokenize）
5. 测试 harness 修正：bun:sqlite prepare()（唔系 query()）+ bind 返回新 wrapper（adapter 契约 immutability）+ async await 补全 + dedup 测试改 capture-only adapter（唔执行 SQL）

**Status:** COMPLETED 2026-09-02 — Phase 11 全部 12 项完成，fde-v1.50.0.2 已推 GitHub（HEAD=2dfd30ac），等主人按 DEPLOY_REMOTE_BUILD_V2.md V2.1 部署 + 远端复测（search_memos C3 + 隔离验证）

**定案规则（主人批准，实施依据）**：
1. **D3 豁免规则（Q1=A）**：CTE 内「纯 id 集合计算」表引用（SELECT 单列 id、无 JOIN 内容表、结果被外层 IN 消费）唔注入。安全依据：外层 m.notebook_id IN (该集合) 与 m.notebook_id NOT IN (隐藏) 取交集，隐藏 id 唔可能出现喺结果。fail-closed 精神保留：识别唔到嘅模式照旧 fail-closed
2. **D4 豁免规则（Q2=A）**：白名单窄化——SQL 全部表引用仅 notebooks（含 recursive CTE 自引用）且无任何其他内容表 → 唔注入（树遍历 utility 唔暴露内容）。写入守卫照旧兜住 move 去隐藏分类嘅 403
3. **注入作用域规则**：表引用携带所在 SELECT 块标识；memos_fts 嘅 bare memo_id 注入到 FTS 子查询自身 WHERE（MATCH 后 AND）；外层 JOIN 表（m./c.）注入到外层 depth-0 WHERE
4. **去重规则**：同 (table, alias) 组合只注入一次

**Status:** COMPLETED 2026-09-02 — Phase 11 全部 12 项完成，fde-v1.50.0.2 已推 GitHub（HEAD=2dfd30ac）

---

### Phase 12: 远端部署后 MCP 功能复测（PENDING — 新 session 执行，本项目最后一个 Phase）

**背景（2026-09-02 第五段 session 末）**：
- 主人已按 DEPLOY_REMOTE_BUILD_V2.md 完成远端 BUILD + 容器更新（fde-v1.50.0.2）
- 本地 MCP（mcp__edgee__）连住远端实例，可即时验证
- 本次验证重点 = 上次 v1.50.0.1 部署实测失败/未覆盖嘅功能

**上次 v1.50.0.1 远端实测基线（2026-09-02 第二段 session，新 session 直接引用）**：

| # | 测试 | 上次结果 | 今次预期 |
|---|------|---------|---------|
| B1 | search_memos query=咖啡 | ❌ ambiguous column name: memo_id | ✅ 正常返回（BUG-001 已修） |
| B2 | search_memos query=教程 | ❌ 同上 | ✅ 正常返回 |
| B3 | search_memos query=docker+notebookId | ❌ 同上 | ✅ 正常返回 |
| B4 | search 隔离语义（C3） | ⏸ 测唔到（工具报错） | ✅ 命中结果唔含隐藏分类笔记 |
| B5 | list_notebooks | ⚠️ 3/4 visible（差1疑似隐藏） | ✅ 同样 3/4（隐藏不变） |
| B6 | list_memos includeContent=false | ✅ 5 条 | ✅ 同样 |
| B7 | get_workspace_stats | ✅ memos 8 / notebooks active 4 / tags 26 | ✅ 同样计数 |
| B8 | get_memo / find_notebooks / list_tags | ✅ 全部正常 | ✅ 同样 |
| B9 | list_memos includeDescendants=1 | 未测（D3 场景） | ✅ 不报 no such column: notebooks.id |
| B10 | move 笔记防环（D4 场景） | 未测 | ✅ 不报错（或正常 403 若目标隐藏） |
| B11 | C5 写隐藏分类 403 | ⏸ 未测（需主人批准） | 主人批准先测 |
| B12 | C6 隐藏分类 get_memo not_found | ⏸ 未测（需隐藏分类 notebook id） | 问主人攞 id 或由 list 差集推 |
| B13 | C7 无隔离 token 对比 | ⏸ 未测 | 需主人提供无隔离 token |

**Phase 12 执行步骤（确定性，新 session 照做）**：
- [ ] 12.1 PWF 恢复：读本文件 Phase 12 + progress.md 尾部 + findings.md BUG-001 章；git 确认 ~/workspace/edgeever 喺 fde-v1.50.0.2（HEAD=2dfd30ac）
- [ ] 12.2 健康基线：mcp__edgee__get_current_user + get_workspace_stats（确认 MCP 链路通 + 数据计数同 B7 一致）
- [ ] 12.3 B1-B3 search_memos 复测（上次 100% 报错项，今次核心验证）
- [ ] 12.4 B4 search 隔离语义：search 命中嘅 notebookId 全部喺可见集（对照 12.2 stats/list_notebooks）
- [ ] 12.5 B5-B8 回归确认（计数/列表同上次一致，无新回归）
- [ ] 12.6 B9 includeDescendants=1 list_memos（D3 修复验证）
- [ ] 12.7 B10-B13 视主人指示与资料可用性执行（写操作需主人批准，C7 需无隔离 token）
- [ ] 12.8 结果全表落 progress.md；全部通过 → 项目转 completed + registry paused_reason 更新「验证完成」；有失败 → 激活调查流程（远端症状 → git diff → 真 SQLite 复现 → findings → 方案 → 主人批 → TDD）

**验收标准**：B1-B4 全部 ✅（BUG-001 修复 + search 隔离语义）+ B5-B8 无回归 = 最低通过线；B9-B13 加分项按条件执行。

**Status:** 大部分完成（2026-09-02 第六段 session 执行）——B1-B9 全部 ✅（含 BUG-001 + D3 修复远端实锤：/api/health build=2dfd30ac + migration=0036）；**验收最低线达成**。B10-B13 待主人批准/提供资料（B10 写操作 / B11 写隐藏 / B12 隐藏 notebook id / B13 无隔离 token）。全过 → 项目转 completed

---

### Phase 12 执行实录补记（2026-09-02 第六段）

- 12.1-12.6 全部执行：B1-B3 search_memos 复活（BUG-001 修复实锤）/ B4 隔离语义正确（「咖啡」搜 0 条 = 主人确认咖啡笔记喺被隔离分类，隔离生效直接证据）/ B5-B8 无回归 / B9 D3 修复 REST 补测通过（includeDescendants=1 → 200）
- /api/health 实锤：build=2dfd30ac + migration=0036
- search_memos 机制确认（主人问）：FTS5 全文搜索（title + content_text + tags 三栏 MATCH bm25 评分）+ LIKE 兜底，正文有字即搜到，唔净系 tag
- B13 取消（主人指示：只用同一 token）；「生活调研」= 主人新建正常分类（非隔离对象，放调研文档用）

### Phase 13: BUG-002 修复 + BUG-003 排查 + B10-B12 收尾（PENDING — 下个 session 执行，项目重启触发器）

**BUG-002：空 notebook 被隔离 wrapper 误杀（2026-09-02 远端发现 + 本地复现实锤）**

**现象**：
- MCP create_notebook + REST POST /notebooks 100% 报 404「Notebook not found after create」（远端 2+1 次，本地 bun:sqlite 复现一致）
- createNotebookRecord 流程：batch INSERT（实际成功）→ getNotebook 验证读取 → 返回 NULL → 报 404
- list_notebooks 同中招：空分类（memoCount=0）从 MCP 结果完全消失（远端实测：WEB 端见 7 本，MCP 只见 4 本，3 个测试分类隐形）
- 有 memo 嘅分类完全正常（B1-B9 全过的原因）
- deleteNotebookRecord 也用 getNotebook → AI 无法删除被误杀分类

**根因（本地真 SQLite 实锤）**：
- notebookSelectSql 模板：FROM notebooks n LEFT JOIN memos m ON m.notebook_id = n.id
- wrapper 注入 memos fragment：AND m.notebook_id NOT IN (隐藏清单) 加喺 WHERE
- 新建/空分类无 memo → LEFT JOIN 后 m.notebook_id = NULL → SQL 三值逻辑 NULL NOT IN (...) = NULL → WHERE 过滤成行
- DIAG 捕获改写后 SQL 实锤（tests/repro-create-notebook-diag.ts）
- 注：LEFT JOIN 的 ON 条件 m.is_deleted=0 不受影响，问题纯在 WHERE 注入位置

**修复方案 A（已定案，等下个 session 实施）**：
- 改 mcp-hiding.ts INJECTION_RULES 嘅 memos fragment 模板：
  旧：`{alias}.notebook_id NOT IN (h1,h2,...)`
  新：`({alias}.notebook_id IS NULL OR {alias}.notebook_id NOT IN (h1,h2,...))`
- 语义安全论证：m.notebook_id IS NULL 意味着该行本来就没有对应 memo（LEFT JOIN 未命中），NULL 不指向任何隐藏 notebook，不构成泄露；只有真实 notebook_id 值才需要 NOT IN 检查
- 同模板排查：resources / memo_revisions / memo_contents 等「JOIN memos 驱动查询」如用 LEFT JOIN 同样要 NULL 安全（实施时 grep 全部注入点确认）；FTS memos_fts memo_id 是 INNER JOIN 语义（MATCH 必有行）不受影响，但保持一致改成 NULL 安全版无害
- TDD 流程：RED（新测试：空 notebook 经 wrapper 后 getNotebook/list 可见 + create_notebook 全流程通过）→ GREEN（改 fragment）→ 全库回归（88 hiding + 15 leak-matrix + 39 real-sqlite + 1200 全库 baseline 一致）→ 三连（typecheck / typecheck:mobile / build:web）
- 交付：fde-v1.50.0.3 分支（或 v1.50.0.2 上追加 commit，实施时定）+ push GitHub + 主人按 DEPLOY_REMOTE_BUILD_V2.md V2.2 rebuild

**BUG-003：rename_tag 静默失败（返回成功但实际未生效，2026-09-02 新报告，未复现未定案）**

**来源**：主人报告 — MCP 工具 mcp__edgee__rename_tag（HTTP API），2026-09-02 约 11:06 UTC，批量 20 次 rename（串行、每次间隔几秒）中唯一一次失败。⚠️ 本节内容系主人观察 + 报告原文记录，AI 尚未做过源码调查，下次修复 session 首要任务 = 验证以下现象系咪真系按报告所述存在。

**现象（报告原文）**：
- rename_tag(from=「服务器」, to=「server」)（中文 tag 改英文），API 返回 ok:true、updated:1，表面完全成功
- 但紧接着下一次操作嘅 dryRun 预览暴露异常：目标 memo 嘅 currentTags 仍然是旧中文 tag「服务器」
- list_tags ground truth 确认：「服务器」依然存在，「server」根本唔存在 —— 即今次 rename 完全无写入，但响应报告成功

**关键细节（报告原文）**：
- 失败嗰次调用之后 list_tags 显示：目标 memo 全部 5 个 tag 嘅 updatedAt 都刷新咗去该次调用嘅时间戳（11:06:51.607Z）—— 说明 memo 记录确实被触碰/重写，但 tag 重命名本身未应用，即 updated:1 反映嘅系「memo 被更新」而唔系「重命名生效」，响应语义与实际 DB 变更不一致
- 用完全相同参数立即重试，返回同样 ok:true updated:1，今次真正成功（list_tags 确认 server 出现、服务器消失）—— 一次性问题，无参数差异，唔系数据问题
- 其余 19 次 rename 全部一次成功，包括 12 个其他中文 tag（如 健康→health、运维→ops、隐私保护→privacy），所以唔太似单纯嘅中文字符编码问题
- 唯一可关联嘅嫌疑：高频连续写操作（前一个 rename 刚完成几秒内发起下一个）或该次请求嘅写路径异常

**影响（报告原文）**：
- API 返回值不可信。调用方如果唔做二次验证，会造成 tag 静默不一致 —— 旧 tag 残留 + 新 tag 缺失，按 tag 检索/过滤笔记时漏数据，而且无任何错误信号

**排查方向（下次 session 执行顺序）**：
1. 读 tag 重命名处理器源码，检查是否存在「先刷 memo.updatedAt，重命名逻辑喺后续分支被条件跳过」嘅路径
2. 确认 ok:true 判定依据系「请求受理」定「变更落库确认」；建议改为后者，或响应返回重命名后实际 tag 名/变更校验值方便客户端确认
3. 排查连续写场景下有无缓存层/索引延迟或并发写竞争导致单次写丢失
4. 顺带确认中文 tag 名嘅编码/规范化处理路径
5. ⚠️ 前置判断：呢个 bug 与隔离 wrapper（BUG-001/002 同源 mcp-hiding.ts）有无关系未确定 —— 排查时先睇上游 tag rename 路径，如果 wrapper 有参与（memo_tags 相关 SQL 被改写）再对照 v1.50.0 基线行为

**B10-B12 收尾（BUG-002 修复后执行）**：
- 清理遗留：3 个空测试分类 DZ_TEST_HIDDEN ×3（WEB 端可见、MCP 隐形；修复后 AI 可 REST DELETE /api/v1/notebooks/:id 删除，或主人 WEB 端手删）
- B10 防环：新建 DZ_TEST_A（父）+ DZ_TEST_B（子）→ PATCH move A into B → 预期 409 notebook_cycle（isNotebookDescendant D4 豁免路径）→ 删干净
- B11 写隐藏 403：新建 DZ_TEST_HIDDEN + 测试 memo → 主人 WEB UI 加隔离 → MCP create_memo 指向 → 预期 403 HiddenNotebookError
- B12 读 not_found：get_memo(隐藏分类内 memo) → 预期 not_found
- 全部测完清理所有测试数据 → stats 对比归零（memos 8 / notebooks 不含测试分类）

**执行顺序**：BUG-003 排查定位（源码调查 + 定性，报告所述现象验证）→ RED → GREEN（BUG-002 + BUG-003 若同属写路径则一并修）→ 回归 → push → 主人 rebuild → 清 3 个遗留分类 → B10 → B11+B12 → 清理验证 → PWF 最终更新 → 项目 completed

**Status:** pending（BUG-002 方案 A 主人已批准 2026-09-02 封存时拍板；BUG-003 已记录待下次 session 排查定性，2026-09-02 主人报告）

---

### Phase 14: Docker named volume → bind mount 迁移（COMPLETED 2026-09-02，项目封存前最后改动）

**背景**：主人远端 EdgeEver 想由官方 named volume `edgeever-data:/data` 改用本地 `./edgeever-data:/data` bind mount，方便成个 folder 备份。

**关键坑（AI 踩坑 2 次 → 主人 `docker volume ls` 实锤）**：
- compose 会 prefix 目录名到 named volume：compose 写 `edgeever-data`，实际 volume 名 = `<目录名>_edgeever-data`（主人服务器 = `edgee_edgeever-data`）
- 之前 AI 用 `docker run -v edgeever-data:/from` 复制失败 100% 因为对住错名（Docker 静默建空 volume）
- 正确做法：`docker volume inspect <真名>` 攞 Mountpoint → host 层 `cp -a <Mountpoint>/. ./edgeever-data/`（保留权限 + WAL 一致性前提 = 先停容器）

**代码改动（commit 6ed18778 + push origin fde-v1.50.0.2）**：
- `compose.yaml`：volumes `edgeever-data:/data` → `./edgeever-data:/data`，删最底 `volumes: edgeever-data:` 宣告
- `apps/site/public/compose.yaml`：同步（AGENTS.md 官网一致要求）
- `docs/deploy-docker.md` + `.zh-CN.md`：docker run 示例 `-v edgeever-data:/data` → `-v ./edgeever-data:/data`
- 唔改：`scripts/docker-release.test.mjs`（line 86 保持官方原样）、DEPLOY_REMOTE_BUILD_V2.md、DEPLOY_V1.50.0.1.md

**完整技术记录**：findings.md「Docker named volume → bind mount 迁移」章

**Status:** complete（主人指示封存，项目转 completed）

---

## Phase 15: fde-v1.50.0.3 修复实施计划（READY TO IMPLEMENT — 2026-09-04 定案，全部方案已 dry-run 实测验证）

### 本 Phase 定位
主人 2026-09-04 拍板 Q1-Q6，指示：**本轮 AI 唔系实施人员**，任务系把「fde-v1.50.0.3 要做嘅事」写成确定性记录，令**下一个 AI 加载项目即知要做乜、点做、点验**。所有该测试/该研究嘅事本轮已做完（包括把 patch 真实改上去跑齐三连 + 全库测试 + 隔离复验，然后**完整回滚**）。下一个 AI 只需照抄执行。

### 🔒 主人拍板锁定（2026-09-04）
| Q | 决定 |
|---|------|
| Q1 修复范围 | **包含 P2**（MEMO_ID_SUBQUERY 服务嘅 6 张表一并 NULL-safe） |
| Q2 BUG-003 | **本版一齐修** |
| Q3 失败语义 | **(b) 宽松式** — 返回 `verified:false` + `remainingOldTag`，**唔抛 409**（唔中断批量流程） |
| Q4 交付物 | commit hash + 变更说明；**以后一律远端 git pull → 远端 docker build → 本地 image → compose 使用**，唔再打 tar |
| Q5 遗留文件 | `edgeever-fde-v1.50.0.1.tar.zst`(176MB) + `DEPLOY_V1.50.0.1.md` → **已删除**（2026-09-04 执行） |
| Q6 DEPLOY V2.2 | **单独一个 commit**（唔混入 fix/test commit） |
| Q7 2 个 repro 脚本 | **(a) 转正式测试资产** —— 已 `chmod 664` + 补 provenance header（含 before/after 预期输出），入 commit 2 |

### ✅ 本轮 dry-run 实测（patch 真改过、跑完、已回滚 —— 下一个 AI 唔使再摸索）
**实施方案已 100% 验证可行，唔系纸上推演：**
1. 两个 fragment 改 NULL-safe → `bun run typecheck` **绿**、`typecheck:mobile` **绿**、`build:web` **绿**
2. 8 个 hiding 测试档：**100 pass / 2 fail** —— 只有 2 条旧断言因括号语法失效（**唔系功能坏**，确切名单同修法见下方「旧断言升级」章）
3. 全库 `bun test`：**1198 pass / 10 fail**（= baseline 1200/8 + 上述 2 条）→ 除咗呢 2 条**零回归**
4. 隔离安全复验（经真 wrapper + 真 SQLite，8 项全过）：空分类可见 ✅ / 空**隐藏**分类仍然 null ✅ / 隐藏分类 null ✅ / 隐藏 memo 唔出 ✅ / 隐藏 resource 唔出（含 standalone SELECT）✅ / stats 计数正确 ✅
5. tag-service verify 改动 + 4 个调用点 + client 类型 → 三连**全绿**，全库无新增 fail
6. BUG-003 修复行为证明（5 个 case，真 trigger）：正常 rename `{updated:2,verified:true,remainingOldTag:0}` / **模拟丢写 `{updated:2,verified:false,remainingOldTag:2}`** / delete_tag verified:true / 无命中 no-op / 同名短路
7. 工作树已**字节级验证回滚干净**（5 个文件 `cmp` 全部 identical），hiding 测试回复 **102 pass / 0 fail**

**已验证 patch 存档（下一个 AI 可以直接 `git apply` 或照抄）**：
- `~/.hermes/docs/edgeever-v1.50.0.3/verified-patch.diff` —— 5 个文件嘅完整 diff，本轮实测通过三连
- `~/.hermes/docs/edgeever-v1.50.0.3/probe-bug002-nulljoin.ts` —— BUG-002/002b 复现+修复验证
- `~/.hermes/docs/edgeever-v1.50.0.3/probe-bug003-sqlite-facts.ts` —— changes/trigger/复用 事实探针
- `~/.hermes/docs/edgeever-v1.50.0.3/probe-bug003-wrapper-excluded.ts` —— 排除 wrapper 参与
- `~/.hermes/docs/edgeever-v1.50.0.3/probe-bug003-fix-proof.ts` —— verified 行为 5 case 证明
- `~/.hermes/docs/edgeever-v1.50.0.3/probe-postpatch-isolation.ts` —— patch 后隔离安全 8 项复验
- ⚠️ 呢 5 个探针**唔属于仓库资产**（唔 commit）；跑法：`cd ~/workspace/edgeever && bun run ~/.hermes/docs/edgeever-v1.50.0.3/<file>`（要喺仓库内跑，import 用绝对路径）

### 环境事实（实测）
- `export PATH="$HOME/.bun/bin:$PATH"`；bun **1.4.0**；node_modules **已在**，唔使 bun install
- 全库 `bun test` 约 4 秒；`bun run typecheck` / `typecheck:mobile` / `build:web` 各数秒（build:web ~3.8s）
- ⚠️ 全库 bun test **唔可以用 600s 前台 timeout**（工具上限）→ 用 `timeout 500 bun test`

### 📌 Baseline 数字（实测 2026-09-04，门禁参照）
- 全库 `bun test`：**1200 pass / 8 fail / 1208 tests / 251 files**
- 8 条 pre-existing fail（**与本次改动无关，唔准当成回归**）：
  1. Docker installer > installs with TCR and preserves the generated password on rerun
  2. Docker installer > prints actionable diagnostics without exposing the password
  3. Docker installer > identifies a NAS bind-mount permission failure and prints a targeted repair
  4. Cloudflare deployment entrypoints > keeps D1 resolver diagnostics out of Wrangler JSON stdout
  5. Cloudflare deployment entrypoints > records the public Worker target reported by a CI deployment
  6. Cloudflare deployment entrypoints > prepares a linear product snapshot without changing downstream workflows
  7. Cloudflare deployment entrypoints > flattens customized merges and preserves their downstream workflows
  8. cross-platform Wrangler runner > runs the project-local Wrangler without a global installation
- 8 个 hiding 测试档：**102 pass / 0 fail**
- `bun test scripts/docker-release.test.mjs`：**7 pass / 0 fail**（bind mount 唔会令 line 86 红，`./edgeever-data:/data` 含 `edgeever-data:/data` 子串）

### 问题清单（本次 fde-v1.50.0.3 范围）
| # | 项目 | 状态 |
|---|------|------|
| P1 | BUG-002 空 notebook 被 wrapper 误杀（LEFT JOIN NULL） | 方案已 dry-run 验证 |
| P2 | BUG-002b MEMO_ID_SUBQUERY（6 张表）同类 NULL 误杀 | 本轮新发现 + 已验证 |
| P3 | BUG-003 rename_tag 静默失败 → verified 语义 | 已定性 + 修复行为已证明 |
| P4 | 清 3 个 DZ_TEST_HIDDEN 空测试分类 | 部署后执行 |
| P5 | B10 防环 / B11 写隐藏 403 / B12 读隐藏 not_found | 部署后执行 |
| P6 | 遗留文件治理 | ✅ 全部处理完（Q5 删 2 个；Q7 保留 2 个 repro 并已加 header + chmod 664） |


---

### P1 + P2：BUG-002 NULL-safe 注入（唯一改动 = mcp-hiding.ts 2 个 fragment builder）

**改动位置**：`apps/api/src/mcp-hiding.ts` line 56-61（`NOTEBOOKS_INJECTION` 唔改）

**BEFORE（现况原文，逐字）**：
```ts
const MEMOS_INJECTION = (alias: string | null, ids: string[]): string =>
  `${alias ?? "memos"}.notebook_id NOT IN (${literalList(ids)})`;

/** For tables linked via memo_id (not notebook_id), inject a subquery. */
const MEMO_ID_SUBQUERY = (alias: string | null, ids: string[]): string =>
  `${alias ? `${alias}.memo_id` : "memo_id"} NOT IN (SELECT id FROM memos WHERE notebook_id IN (${literalList(ids)}))`;
```

**AFTER（本轮实测通过嘅版本，逐字照抄）**：
```ts
const MEMOS_INJECTION = (alias: string | null, ids: string[]): string => {
  const column = `${alias ?? "memos"}.notebook_id`;
  return `(${column} IS NULL OR ${column} NOT IN (${literalList(ids)}))`;
};

/** For tables linked via memo_id (not notebook_id), inject a subquery. */
const MEMO_ID_SUBQUERY = (alias: string | null, ids: string[]): string => {
  const column = alias ? `${alias}.memo_id` : "memo_id";
  return `(${column} IS NULL OR ${column} NOT IN (SELECT id FROM memos WHERE notebook_id IN (${literalList(ids)})))`;
};
```
（用局部 `column` 变量避免重复模板拼接出错；实测 typecheck 绿）

**改写产物示例（实测捕获，FTS CTE 场景）**：
```
... FROM memos_fts WHERE memos_fts MATCH ? AND (memo_id IS NULL OR memo_id NOT IN (SELECT id FROM memos WHERE notebook_id IN ('nb_secret_1', 'nb_secret_2')))
... WHERE m.workspace_id = ? AND (m.notebook_id IS NULL OR m.notebook_id NOT IN (...)) AND (mc.memo_id IS NULL OR mc.memo_id NOT IN (SELECT id FROM memos WHERE notebook_id IN (...)))
```

**`NOTEBOOKS_INJECTION` 唔改嘅理由**：notebooks 永远系驱动表（`FROM notebooks n`），`n.id` 系 PK NOT NULL，冇 NULL 行；加 IS NULL 只会扩大接受面，违反 fail-closed。**实测确认**：空隐藏分类（nb_hidden_empty）喺 patch 后仍然返回 null ✅ —— 即隐藏语义完全由 NOTEBOOKS_INJECTION 守住，NULL-safe 唔会放走隐藏分类。

**安全论证（三层，已实测）**：
1. `col IS NULL` 只可能来自 OUTER JOIN 未命中。memos.notebook_id / memo_contents.memo_id / memo_tags.memo_id / resources.memo_id / memo_revisions.memo_id **全部 schema NOT NULL**（0001_initial:33 + 0034:19 + 0035:4 核实）→ NULL 只可能系 JOIN 合成行，唔指向任何 notebook
2. 隐藏 notebook 本体由 `n.id NOT IN` 拦死（实测 C/D 项 null）
3. 写入面唔受影响（fragment 只用于 SELECT；写入靠 hiding-guards.ts 403）

**受益路径（grep 全库 LEFT JOIN 实测 5 处）**：
- `notebook-service.ts:50` notebookSelectSql → getNotebook(:130) / listNotebooks(:54) / createNotebookRecord 验证读(:179) / deleteNotebookRecord(:251) —— **BUG-002 主症状喺呢条**
- `sync-routes.ts:73` /sync/bootstrap、`sync-routes.ts:186` /sync/changes → agent REST 亦会重新见到空分类（正确行为回归）
- `index.ts:588-589` demo seed（LEFT JOIN memo_contents + memo_search_documents）→ P2 受益
- `sync-routes.ts:145` LEFT JOIN page_changes → 非内容表，唔受影响

**为何唔用「条件移入 JOIN ON」**：wrapper 系后期 SQL 改写，要判定表引用属于边个 JOIN 子句 + ON 边界，需重写 injectWhereAtDepth 块定位算法（Phase 11 血泪区）。NULL-safe fragment = 6 行改动、零架构变动、已实测三连绿。


---

### P3：BUG-003 rename_tag 响应可信化（Q3=b 宽松式，5 个文件）

**根因（源码事实，无需复现即成立）**：`tag-service.ts:112` 嘅 `updated` 系 JS 循环计数，`db.batch(statements)`（:115）返回值**完全被丢弃** → `ok:true, updated:N` 只代表「组装咗 N 条 statement」，唔代表落库。主人观察嘅「updated:1 但零写入」完全符合。

**已排除嘅假设（真 SQLite 实测）**：hiding wrapper 参与（改写后 tag SQL 执行正确）/ SQL 文本复用丢写 / trigger 唔触发。
**⚠️ 唔可以用 `changes` 判定**：trigger 内 DELETE+INSERT 会计入 changes（单行 UPDATE 实测 changes=**5**）。

#### 改动 1/5：`apps/api/src/tag-service.ts`

**新增导出类型 + 改 `updateTagAcrossMemos`（BEFORE = 现况 :75-117）**

**AFTER（本轮实测通过，逐字照抄）** —— 喺 `listTagSummaries` 之后、`updateTagAcrossMemos` 之前插入类型，然后改函数签名同 3 处 return：
```ts
export type TagUpdateOutcome = {
  /** Number of memos the service intended to update (statement count). */
  updated: number;
  /** True when a post-write ground-truth re-read confirmed the rename/delete. */
  verified: boolean;
  /** Memos that still carry the old tag after the write (0 when verified). */
  remainingOldTag: number;
};

export const updateTagAcrossMemos = async (
  db: DatabaseAdapter,
  workspaceId: string,
  oldTag: string,
  nextTag: string | null,
  actor: AuditActor,
  actorLabel: string
): Promise<TagUpdateOutcome> => {
  const normalizedOld = normalizeTags([oldTag])[0];
  const normalizedNext = nextTag === null ? null : normalizeTags([nextTag])[0];

  if (!normalizedOld || normalizedOld === normalizedNext) {
    return { updated: 0, verified: true, remainingOldTag: 0 };
  }

  // ... 中间循环体完全不变（rows / statements / updated += 1）...

  if (statements.length > 0) await db.batch(statements);

  // Post-write ground-truth verification: the old tag must be gone. Without
  // this the response only reflects statement assembly, not persistence.
  const remaining = updated === 0 ? [] : await getMemoRowsByTag(db, workspaceId, normalizedOld);
  return { updated, verified: remaining.length === 0, remainingOldTag: remaining.length };
};
```
关键点：
- 短路分支 `return 0` → `return { updated: 0, verified: true, remainingOldTag: 0 }`
- 尾部 `return updated` → 先 ground-truth 复查再返 object
- `updated === 0` 时**跳过复查**（省一次 query，语义上冇写入就冇嘢要验）
- **循环体一个字都唔改**

#### 改动 2/5：`apps/api/src/mcp-tool-service.ts`（2 处）
`rename_tag` 分支（:424-425）+ `delete_tag` 分支（:435-436），两处同一模式：
```ts
// BEFORE
const updated = await updateTagAcrossMemos(...);
return { ok: true, updated };
// AFTER
const outcome = await updateTagAcrossMemos(...);
return { ok: true, ...outcome };
```

#### 改动 3/5：`apps/api/src/tag-routes.ts`（2 处）
PATCH `/api/v1/tags/:tag`（:36-44）+ DELETE `/api/v1/tags/:tag`（:51-59）：
```ts
// BEFORE
const updated = await updateTagAcrossMemos(...);
return c.json({ ok: true, updated });
// AFTER
const outcome = await updateTagAcrossMemos(...);
return c.json({ ok: true, ...outcome });
```

#### 改动 4/5：`packages/client/src/index.ts`（:596-605）
`renameTag` + `deleteTag` 嘅 response 类型加**可选**字段（可选 = 唔破坏现有 consumer）：
```ts
request<{ ok: true; updated: number; verified?: boolean; remainingOldTag?: number }>(...)
```

#### 改动 5/5（**唔使改，实测确认**）
- `apps/web/src/lib/repository.ts:66-67` 声明 `Promise<{ ok: true; updated: number }>` —— **typecheck 实测绿**（结构类型：多返字段兼容）
- `apps/web/src/lib/plugins/plugin-host.ts:625,632` 用 `const { updated } = ...` —— 解构照旧可用
- `TagsPane.tsx` / `sync-queue.ts` / `desktop-sync.ts` —— 无改动需要
- **实测**：三连（typecheck / typecheck:mobile / build:web）全绿，全库测试无新增 fail

**修复行为实测（探针 probe-bug003-fix-proof.ts，真 trigger + 真 SQLite）**：
| Case | 输入 | 实测输出 |
|------|------|---------|
| 1 正常 rename（2 memo 带旧 tag） | 服务器→server | `{updated:2, verified:true, remainingOldTag:0}` |
| 2 **模拟静默丢写**（batch 吞掉写入） | 服务器→server | `{updated:2, verified:false, remainingOldTag:2}` ✅ 唔再静默 ok |
| 3 delete_tag（nextTag=null） | 健康→null | `{updated:1, verified:true, remainingOldTag:0}` |
| 4 tag 唔存在 | does_not_exist→x | `{updated:0, verified:true, remainingOldTag:0}` |
| 5 同名短路 | server→server | `{updated:0, verified:true, remainingOldTag:0}` |

**调用方使用指引（写入 DEPLOY 说明 / 告知 AI 客户端）**：`verified:false` = 写入未确认，`remainingOldTag` = 仲有几多条带旧 tag；调用方**自行决定重试**（rename 幂等，主人实测第二次即成功）。唔抛错 = 批量 20 次 rename 唔会中断。

**诚实标注（唔可以删）**：单次真实丢写嘅**触发条件仍未复现**（20 次中 1 次）。本修复目标 = **令静默失败变成可见失败**，唔承诺消灭。若日后 `verified:false` 真系再出现，届时有确切数据（remainingOldTag + 时间点）再追根因。


---

### 🔧 旧断言升级（确切 2 条，本轮实测得出，其余 100 条唔使动）

改咗 NULL-safe 之后，只有 **2 条**旧断言会红（因为注入片段由 `m.notebook_id NOT IN ...` 变成 `(m.notebook_id IS NULL OR m.notebook_id NOT IN ...)`，`toContain` 类断言仍然过，但**紧邻正则**唔再匹配）。**两条都系断言写法问题，唔系功能坏** —— 实测改写产物完全正确。

#### 红断言 1：`tests/mcp-hiding.test.ts:220`
测试名：`9.4 HidingDatabaseAdapter > FTS5 CTE query → inject memo_id NOT IN in FTS subquery`

**现况（会红）**：
```ts
expect(rewritten).toMatch(/memos_fts MATCH \? AND memo_id NOT IN/);
```
**实测收到嘅真实字串**：`... memos_fts MATCH ? AND (memo_id IS NULL OR memo_id NOT IN (SELECT id FROM memos WHERE notebook_id IN (...)))`

**指定改法（保留原意：FTS 注入必须喺 CTE 内 MATCH 之后）**：
```ts
expect(rewritten).toMatch(/memos_fts MATCH \? AND \(memo_id IS NULL OR memo_id NOT IN/);
```

同一 test 内 :221 嘅负向断言 `expect(rewritten).not.toMatch(/WHERE m\.workspace_id = \? AND memo_id NOT IN/)` —— **实测唔会红**（照旧成立），唔使改。

#### 红断言 2：`tests/mcp-hiding-real-sqlite.test.ts:371`
测试名：`mcp-hiding real-SQLite execution (BUG-001 fix) > dedup: same (table, alias) referenced in CTE and outer level injects ONCE each`

**现况（会红）**：
```ts
expect(/memos_fts MATCH \? AND memo_id NOT IN/.test(rewritten)).toBe(true);
```
**指定改法**：
```ts
expect(/memos_fts MATCH \? AND \(memo_id IS NULL OR memo_id NOT IN/.test(rewritten)).toBe(true);
```

同一 test 内 :362-365 嘅 `countOccurrences(rewritten, "m.notebook_id NOT IN")` 同 `countOccurrences(rewritten, "c.memo_id NOT IN (SELECT id FROM memos")` —— **实测仍然各为 1**（子串照旧存在一次），唔使改；:368 负向正则亦唔会红。

**⚠️ 铁律**：只准升级断言写法去匹配**新嘅正确产物**，绝对唔准为迁就测试而削弱 NULL-safe 修复（例如改成只加 memos 唔加 MEMO_ID_SUBQUERY）。

---

### 🧪 新测试档规格（2 个档，下一个 AI 照建）

#### 新档 1：`tests/mcp-hiding-null-join.test.ts`（BUG-002 / P1+P2 回归守护）
用真 bun:sqlite（唔准只用 toContain）。**Fixture schema 必须跟真实 migration**（0001_initial.sql:4 notebooks PK 系单列 `id TEXT PRIMARY KEY`，用组合 PK 会报 `foreign key mismatch`）：
```ts
db.exec(`CREATE TABLE notebooks (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, parent_id TEXT, name TEXT NOT NULL, slug TEXT, icon TEXT, color TEXT, sort_order INTEGER DEFAULT 0, created_at TEXT DEFAULT '', updated_at TEXT DEFAULT '', is_deleted INTEGER NOT NULL DEFAULT 0)`);
db.exec(`CREATE TABLE memos (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, notebook_id TEXT NOT NULL, title TEXT, updated_at TEXT DEFAULT '', is_deleted INTEGER NOT NULL DEFAULT 0)`);
db.exec(`CREATE TABLE memo_contents (memo_id TEXT PRIMARY KEY, content_text TEXT NOT NULL DEFAULT '')`);
db.exec(`CREATE TABLE resources (id TEXT PRIMARY KEY, memo_id TEXT NOT NULL, is_deleted INTEGER NOT NULL DEFAULT 0)`);
```
Seed（4 本 notebook 覆盖边界 + 1 条无 content 嘅 memo）：`nb_ok`(有 memo) / `nb_empty`(空，可见) / `nb_hidden`(有 memo，隐藏) / `nb_hidden_empty`(空，隐藏)；memos `m_ok`(nb_ok) / `m_hid`(nb_hidden) / `m_nocontent`(nb_ok，冇 memo_contents 行)。
HIDDEN set = `new Set(["nb_hidden","nb_hidden_empty"])`。

断言清单（RED 阶段预期：T1-T4 FAIL、T5-T8 PASS）：
| # | 场景 | 断言 | 本轮实测 patch 后结果 |
|---|------|------|---------------------|
| T1 | notebookSelectSql 真模板 list | `nb_empty` 出现且 memo_count=0 | ✅ `["nb_empty:0","nb_ok:1"]` |
| T2 | getNotebook(WHERE n.id=?) 单本 | `nb_empty` 查得到（非 null） | ✅ `{"id":"nb_empty"}` |
| T3 | `memos m LEFT JOIN memo_contents c` | `m_nocontent` 出现（P2） | ✅ 出现 |
| T4 | sync-routes.ts:70-76 bootstrap SQL 原文 | `nb_empty` 出现 | ✅ 出现 |
| T5 | getNotebook(`nb_hidden_empty`) | **必须 null**（空隐藏分类唔准现身） | ✅ null |
| T6 | getNotebook(`nb_hidden`) | **必须 null** | ✅ null |
| T7 | memos INNER JOIN memo_contents | `m_hid` **唔出现** | ✅ 只有 m_ok |
| T8 | resources standalone SELECT + JOIN memos 两种 | `r_hid` **唔出现** | ✅ 只有 r_ok |
（T1-T8 全部实测过，可直接照 `probe-postpatch-isolation.ts` 嘅查询语句抄）

#### 新档 2：`tests/tag-rename-verify.test.ts`（BUG-003 / P3）
用真 bun:sqlite + **真 trigger**（照抄 0035_normalized_memo_tags.sql:24 单行 trigger 原文）。需要 4 张表：memos / memo_contents / memo_tags / memo_search_documents / audit_events（audit + search doc 因为 batch 会写入）。
Adapter 要支持 `swallowWrites` 开关（模拟静默丢写）—— 照抄 `probe-bug003-fix-proof.ts` 嘅 adapter 实现。

断言清单（对应实测 5 case）：
| # | 场景 | 断言 |
|---|------|------|
| T9 | 正常 rename 2 memo | `{updated:2, verified:true, remainingOldTag:0}` + memo_tags ground truth 变成新 tag |
| T10 | batch 吞写（swallowWrites=true） | `verified === false` 且 `remainingOldTag === 2`（**RED 阶段呢条必 FAIL**） |
| T11 | delete_tag（nextTag=null） | `{updated:1, verified:true, remainingOldTag:0}` + 旧 tag 消失 |
| T12 | tag 唔存在 | `{updated:0, verified:true, remainingOldTag:0}` |
| T13 | 同名短路 | `{updated:0, verified:true, remainingOldTag:0}` |
| T14 | dryRun 路径（previewTagRename） | 行为不变（仍返 `{dryRun:true, updated, changes}`） |

⚠️ 新测试档写完即 `chmod 664`（AI 写文件默认 600，已出过两次事故）。

---

### 📋 执行步骤（下一个 AI 照抄，串行，TDD Iron Law：无失败测试唔写生产代码）
【⏳ 历史存档：Phase 15 已于 2026-09-04 执行完毕，本节只作记录；现行工作模式见「⚡ 工作模式规则」章（整体串行 + 效率型批量并行）】

**15.0 前置（唔改代码，约 1 分钟）**
```bash
export PATH="$HOME/.bun/bin:$PATH"
cd ~/workspace/edgeever
git branch --show-current          # 期望 fde-v1.50.0.2
git log --oneline -1               # 期望 6ed18778
git status -s                      # 期望：M DEPLOY_REMOTE_BUILD_V2.md + ?? tests/repro-create-notebook*.ts
timeout 500 bun test 2>&1 | grep -E "^ [0-9]+ pass|^ [0-9]+ fail"   # 期望 1200 pass / 8 fail
git checkout -b fde-v1.50.0.3
```
若 baseline 唔系 1200/8 → **停手报告主人**（代表环境或上游有变，唔可以照跑）

**15.1 RED-1（BUG-002）**
- 建 `tests/mcp-hiding-null-join.test.ts`（规格见上方「新档 1」）→ `chmod 664`
- `timeout 300 bun test tests/mcp-hiding-null-join.test.ts`
- **期望：T1-T4 FAIL / T5-T8 PASS**，且 FAIL 原因系「空分类/空右侧行缺失」而唔系 SQL 语法错（⚠️ Phase 11 DOUBT 2 教训：fixture 本身必须系有效 SQL，唔可以自盲）

**15.2 GREEN-1（改 mcp-hiding.ts）**
- 照「P1+P2 章」AFTER 代码块改 2 个 fragment builder
- 亦可直接 `git apply ~/.hermes/docs/edgeever-v1.50.0.3/verified-patch.diff`（含全部 5 个文件，即一次过做完 GREEN-1+GREEN-2；但 TDD 纪律建议分开做）
- 跑新测试 → 全绿
- 跑 8 个 hiding 档：
```bash
timeout 400 bun test tests/mcp-hiding.test.ts tests/mcp-hiding-real-sqlite.test.ts tests/leak-matrix.test.ts tests/hiding-guards.test.ts tests/hiding-routes.test.ts tests/auth-hiding.test.ts tests/migration-0036.test.ts tests/spike-v1.50.0.test.ts
```
- **期望：100 pass / 2 fail**，且两条 fail **正好系**「旧断言升级」章列嘅 2 条（mcp-hiding.test.ts:220 + mcp-hiding-real-sqlite.test.ts:371）。若有第 3 条 fail → 停手调查，唔准改断言掩盖

**15.3 升级 2 条旧断言**
- 按「旧断言升级」章嘅**指定改法**逐字改
- 再跑 8 个 hiding 档 → **期望 102 pass / 0 fail**（+ 新档嘅 T1-T8 亦绿）

**15.4 RED-2（BUG-003）**
- 建 `tests/tag-rename-verify.test.ts`（规格见「新档 2」）→ `chmod 664`
- **期望：T9 编译期/断言 FAIL（`verified` 唔存在）+ T10 FAIL（现况静默 ok）**

**15.5 GREEN-2（改 tag 路径 5 个文件）**
- 照「P3 章」改动 1/5 ~ 4/5（tag-service.ts / mcp-tool-service.ts ×2 / tag-routes.ts ×2 / packages/client/src/index.ts）
- 改动 5/5 = **确认唔使改**（repository.ts / plugin-host.ts / TagsPane.tsx / sync-queue.ts / desktop-sync.ts）
- 跑 `tests/tag-rename-verify.test.ts` → T9-T14 全绿

**15.6 回归门禁（硬 GATE，逐条对数字；任一唔过唔准 push）**
```bash
timeout 400 bun test tests/mcp-hiding.test.ts tests/mcp-hiding-real-sqlite.test.ts tests/leak-matrix.test.ts tests/hiding-guards.test.ts tests/hiding-routes.test.ts tests/auth-hiding.test.ts tests/migration-0036.test.ts tests/spike-v1.50.0.test.ts   # 102 pass / 0 fail
timeout 500 bun test 2>&1 | grep -E "^\(fail\)|^ [0-9]+ pass|^ [0-9]+ fail"                                                    # pass ≥ 1200+新测试数，fail 必须 = 8 且名单同 baseline 一致
bun run typecheck            # 绿
bun run typecheck:mobile     # 绿
bun run build:web            # 绿
bun test scripts/docker-release.test.mjs   # 7 pass / 0 fail
find . -path ./node_modules -prune -o -name "*.ts" -perm 600 -print   # 应为空；有就 chmod 664
bun run ~/.hermes/docs/edgeever-v1.50.0.3/probe-postpatch-isolation.ts   # 8 项隔离复验，对照 Phase 15 实测输出
```
⚠️ **fail 数必须正好 8 条且名单逐个对上**（Docker installer ×3 / Cloudflare deployment entrypoints ×4 / Wrangler runner ×1）。唔准用「总数差唔多」蒙过去。



**15.7 交付（Q6 = 4 个 commit，DEPLOY 文档单独一个）**
```bash
# commit 1 — 生产代码
git add apps/api/src/mcp-hiding.ts apps/api/src/tag-service.ts apps/api/src/mcp-tool-service.ts apps/api/src/tag-routes.ts packages/client/src/index.ts
git commit -m "fix: NULL-safe hiding injection for OUTER JOIN rows + verified tag rename outcome"
# commit 2 — 测试（含 Q7 保留嘅 2 个 repro 脚本）
git add tests/mcp-hiding-null-join.test.ts tests/tag-rename-verify.test.ts tests/mcp-hiding.test.ts tests/mcp-hiding-real-sqlite.test.ts tests/repro-create-notebook.ts tests/repro-create-notebook-diag.ts
git commit -m "test: empty-notebook NULL join guards + tag rename verification suite"
# commit 3 — DEPLOY 教程（Q6：单独 commit）
git add DEPLOY_REMOTE_BUILD_V2.md
git commit -m "docs: DEPLOY_REMOTE_BUILD V2.3 for fde-v1.50.0.3 remote build flow"
# push branch + tag（⚠️ 同名必须分开 refspec）
git push -u origin refs/heads/fde-v1.50.0.3:refs/heads/fde-v1.50.0.3
git tag -a fde-v1.50.0.3 -m "BUG-002/002b NULL-safe injection + BUG-003 verified tag rename"
git push origin refs/tags/fde-v1.50.0.3:refs/tags/fde-v1.50.0.3
git ls-remote origin fde-v1.50.0.3   # 核对 hash 与本地 HEAD 一致
```
⚠️ DEPLOY_REMOTE_BUILD_V2.md 现时系 **V2.2 本地 modified 未 commit** → 本次先升 V2.3（版本号 v1.50.0.2→v1.50.0.3 全文 grep：build 命令 / .env EDGE_EVER_VERSION / 日常升级第 3 步 / BUILD_ID / 镜像 tag；**回滚锚点语境嘅旧版本号系合法保留**）然后 commit。V2.1 残留事故教训：升级完必 `grep -n "1\.50\.0\.2" DEPLOY_REMOTE_BUILD_V2.md` 逐处核。
⚠️ DEPLOY V2.3 要写清 Q4 定案：**以后一律远端 git pull → 远端 docker build → 本地 image → compose 用**，唔再打 tar 传输。
⚠️ DEPLOY V2.3 亦要加一段「BUG-003 verified 字段说明」（调用方见到 `verified:false` 应自行重试）。

**15.8 交付物（交主人）**
- branch `fde-v1.50.0.3` + tag 同名，commit hash 4 条
- 变更说明（面向主人，唔写技术验证细节）：
  1. AI 现在可以正常新建分类（之前 100% 报 404）
  2. AI 现在见到空分类（之前空分类喺 MCP 完全隐形）
  3. 无 memo_contents 嘅笔记唔再被误过滤
  4. rename_tag / delete_tag 响应新增 `verified` + `remainingOldTag`，静默失败变可见
  5. 隔离功能唔变（隐藏分类同其内容仍然完全不可见）
  6. **无 schema 变化**（migration 仍然 0036，唔使 migrate）
- 远端升级命令（照 DEPLOY_REMOTE_BUILD_V2.md V2.3）：`git fetch --tags && git checkout fde-v1.50.0.3 && git pull` → `docker build --build-arg EDGE_EVER_BUILD_ID=<commit hash> -t edgeever-fde:v1.50.0.3 .` → `.env` 改 `EDGE_EVER_VERSION=v1.50.0.3` → `docker compose up -d`

**15.9 回滚方案**
- 首选：远端 `git checkout fde-v1.50.0.2` → rebuild →`.env` 改回 v1.50.0.2 → `compose up -d`（**无 schema 变化，秒回**）
- 次选锚点：`fde-v1.50.0.1`(5ab893a6)
- 本地单文件回滚：`git checkout fde-v1.50.0.2 -- apps/api/src/mcp-hiding.ts apps/api/src/tag-service.ts apps/api/src/mcp-tool-service.ts apps/api/src/tag-routes.ts packages/client/src/index.ts`

**15.10 部署后远端验证（主人 rebuild 完成后，AI 用 mcp__edgee__ + REST 执行）**
| # | 验证 | 预期 |
|---|------|------|
| V0 | `GET /api/health` | build = fde-v1.50.0.3 HEAD 前 12 位 + migration=0036 |
| V1 | `list_notebooks` | **见到 3 个 DZ_TEST_HIDDEN**（P1 修复实锤：之前 MCP 隐形） |
| V2 | `create_notebook("DZ_TEST_A")` | **200 成功**（BUG-002 主症状清零） |
| V3 | 隔离守护 | 被隔离分类仍然唔喺 list_notebooks；stats 全局计数 vs list 差值语义不变 |
| V4 | `search_memos` 抽 2 条 query | 无回归（BUG-001 修复唔可以被本次破坏） |
| V5 | `rename_tag` 建测试 tag 做 1 次 rename | response 有 `verified:true` + `remainingOldTag:0`，list_tags ground truth 一致 |
| P4 | REST DELETE 3 个 DZ_TEST_HIDDEN | 删除成功（deleteNotebookRecord 现在读得到空分类） |
| P5-B10 | 建 DZ_TEST_A(父)+DZ_TEST_B(子) → PATCH move A into B | 409 `notebook_cycle`（D4 豁免路径），然后删干净 |
| P5-B11 | 建 DZ_TEST_HIDDEN2 → 主人 WEB UI 加隔离 → MCP create_memo 指向 | 403 HiddenNotebookError |
| P5-B12 | `get_memo`(隐藏分类内 memo) | not_found |
| 收尾 | 清所有 DZ_TEST_* | stats 归位（memos 8 / notebooks 唔含测试分类） |

⚠️ **测试数据铁律**：只用 `DZ_TEST_*` 新建数据，**绝对唔掂主人现有笔记**；测完即清；被 bug 阻住删唔到就写入 PWF。

---

### ✅ 待决事项：全部清零（2026-09-04）
Q1-Q7 全部由主人拍板并已落实。**下一个 session 唔需要再问任何问题，直接由 15.0 执行到 15.10。**

**Q7 执行记录**：`tests/repro-create-notebook.ts` + `tests/repro-create-notebook-diag.ts` 转正式测试资产：
- `chmod 664` 已做（原 600）
- 补咗 provenance header（照 `tests/doubt-first-check.ts` 同 `tests/repro-search-bug.ts` 嘅既有规范）：用途 / 唔系 bun:test 档 / 手动跑法 / 根因说明 / **before-fix 同 after-fix 嘅预期输出** / 永久回归覆盖喺边
- 实跑验证仍然正常（before-fix 行为：TEST2 FAIL 复现 bug、TEST3 baseline PASS；DIAG 打印出 `AND m.notebook_id NOT IN (...)` 元凶片段）
- 已确认**唔会被 `bun test` 收集**（改完后全库仍然 1200 pass / 8 fail / 1208 tests / 251 files）
- ⚠️ 呢 2 个脚本喺 15.2 GREEN-1 之后**会转为 after-fix 行为**（TEST2 变 PASS、DIAG 打印 NULL-safe 片段）—— 呢个系预期，header 已写明，唔准当成坏咗

**Status:** ✅ COMPLETED（2026-09-04）—— 全部 15.0-15.8 实施 + 交付完成，实绩见本文件顶部「Phase 15 实施实绩」表。15.10 验证已独立成 **Phase 16**。

---

## Phase 16: 远端功能验证（PENDING — 交下一个 AI 执行，本项目最后一个 Phase）

### 本 Phase 定位
主人 2026-09-04 指示：**「远端已经成功 BUILD 和 RUN 紧 V1.50.0.3。你只负责做实施，测试工作交给下一个 AI。」**
所以：实施 AI（fde-v1.50.0.3 三个 commit 嘅作者）**唔做验证**，本章系写给测试 AI 嘅确定性执行清单。

**测试 AI 唔准做嘅事**：
- ❌ 唔准改任何代码（实施已封版，HEAD=33f53658 工作树干净）
- ❌ 唔准 commit / push / 开新分支 / 打新 tag
- ❌ 唔准跑 docker build / 唔准打 tar（远端已 RUN 紧）
- ❌ 唔准掂主人现有笔记（写操作只准用 `DZ_TEST_*` 新建数据）
- ❌ 唔准 load 「edgee-mcp」skill（**该 skill 不存在**，直接用 `mcp__edgee__` 工具）

### 16.0 前置确认（第一件事，唔使问主人）
读 `https://edgee.bnicetome.top/api/health`：
- **期望**：`{"ok":true, "build":"33f53658…", "migration":"0036_mcp_token_hidden.sql", ...}`
- `build` = **33f53658**（前 12 位）→ 确认远端跑紧 v1.50.0.3
- `migration` 应仍然係 **0036_mcp_token_hidden.sql**（本版无 schema 变化）
- ⚠️ 若 `build` 仍然係 `2dfd30ac` = 远端仲係 v1.50.0.2 → **停手报告主人**，唔好照跑（会验错版本）
- 抓法：`mcp__edgee__` 无 health 工具 → 用 REST（自己部署实例 = curl 豁免，见下方「REST 补测手法」）

### 16.1 验证清单（11 项，照顺序做；每项做完即刻记入 progress.md）

| # | 验证 | 预期 | 备注 |
|---|------|------|------|
| V0 | `GET /api/health` | build=33f53658 + migration=0036 | = 16.0，唔过就停手 |
| V1 | `mcp__edgee__list_notebooks` | **见到 3 个 DZ_TEST_HIDDEN 空分类** | P1 修复实锤：v1.50.0.2 时呢 3 个喺 MCP 完全隐形（主人喺 WEB 端见到，MCP 见唔到） |
| V2 | `mcp__edgee__create_notebook("DZ_TEST_A")` | **成功返回 notebook id** | BUG-002 主症状清零（旧版 100% 报 `Notebook not found after create`） |
| V3 | 隔离守护 | 被隔离分类（咖啡笔记）**仍然唔喺** list_notebooks；`get_workspace_stats` 全局计数 > list_notebooks 数量 | ⚠️ stats 系**全局计数不动**（v1.50.0 定案），差值系预期唔係 bug |
| V4 | `mcp__edgee__search_memos` 抽 2 条 query（如「教程」「docker」） | 正常返回，**唔报** `ambiguous column name: memo_id` | BUG-001 修复唔可以被本次破坏 |
| V5 | 建测试 tag → `mcp__edgee__rename_tag` 一次 | response 含 **`verified: true` + `remainingOldTag: 0`**；`list_tags` ground truth 一致 | BUG-003 新字段实锤 |
| P4 | 删 3 个 DZ_TEST_HIDDEN（REST DELETE 或 MCP） | **删除成功** | 旧版因 deleteNotebookRecord 读唔到空分类而删唔到 |
| P5-B10 | 建 DZ_TEST_P(父) + DZ_TEST_C(子，parentId=P) → PATCH 把 P move 入 C | **409 `notebook_cycle`** | D4 tree-walk 豁免路径；⚠️ 必须用**新建可见分类**做，唔可以用隐藏分类（会先被 403 拦住摸唔到防环检查） |
| P5-B11 | 建 DZ_TEST_HIDDEN2 → **请主人喺 WEB UI 加隔离** → MCP `create_memo` 指向佢 | **403 HiddenNotebookError** | 需要主人配合一步（AI 冇 owner session 改隔离设定） |
| P5-B12 | `mcp__edgee__get_memo`（隐藏分类内某 memo 嘅 id） | **not_found** | 唔暴露存在性 |
| 收尾 | 清所有 `DZ_TEST_*`（分类 + memo + tag） | `list_notebooks` / `list_tags` 回到测试前状态 | 逐个记 id 便于清理 |

### 16.2 REST 补测手法（V0 / P4 / B10 需要，实锤可复用）
- **实例**：`https://edgee.bnicetome.top`（主人自己部署 → curl 豁免适用；⚠️ 唔准 curl 任何第三方站）
- **Token**：用 python regex 从 `~/.hermes/config.yaml` 抽 `eev_[A-Za-z0-9+/=_-]+`
  - ⚠️ **awk 范围模式实测失手**（抽出 0 chars）→ 一定用 python regex
  - 呢条 token = MCP 同一条 agent token（authenticateRequest 共用），所以 REST 亦受隔离
- **调用**：`curl -H "Authorization: Bearer <token>" https://edgee.bnicetome.top/api/v1/...`
- **唔准喺输出回显 token 值**（引用叫「agent token」即可）

### 16.3 为何有啲项要走 REST
MCP 工具 schema ≠ REST 参数全集。已知：
- `/api/health` 冇 MCP 工具 → 必须 REST
- notebook PATCH（move / 改 parentId）MCP 未暴露 → B10 走 REST `PATCH /api/v1/notebooks/:id`
- `includeDescendants` 只有 REST `/api/v1/memos` 支持（历史 B9 实锤）
落手前若唔确定某参数 MCP 有冇，先 grep 源码确认触发路径喺边层，唔好靠估。

### 16.4 结果处理
- **全部通过** → 更新 progress.md 结果全表 + task_plan Status 改 COMPLETED + registry `status: completed`，告知主人验收完成
- **任一失败** → **唔准即场改代码**。按既有调查流程：远端症状 → `git diff <tag> -- <file>` 确认业务 SQL 未变 → 本地 bun:sqlite 复现（fake adapter 捕获改写产物）→ 证据写入 findings.md → 方案交主人批 → 主人发话才开新分支做 TDD 修复
- **被 bug 阻住删唔到嘅测试数据** → 喺 PWF 明确记录遗留 id + 清理路径，唔好静静留住

### 16.5 验收标准
- **最低通过线**：V0 + V1 + V2 + V3 + V4（= 本版修复主症状清零 + 隔离未削弱 + 无回归）
- **加分项**：V5 / P4 / P5-B10 / P5-B12（B11 需主人配合，唔算硬性）
- 收尾清理**唔係加分项，係必做**

**Status:** 🧪 PHASE 16 RUNNING — V0/V2/V4/V5/B10 ✅ PASS（2026-09-04）；V1/V3 改编通过待 B11 复测；剩余 B11/B12/P4 等主人 WEB UI 加隔离；收尾清理未做。测试 ID 台账喺 progress.md 第六段。


---

## 🚀 下一个 SESSION 开场清单（⏳ 已执行完毕存档 — Phase 16 已 11/11 完成 2026-09-04，勿再按此执行；现行任务 = 文件顶部 Phase 17/18）

**实施已封版 + 远端已部署 v1.50.0.3。下一个 AI 唯一任务 = Phase 16 远端功能验证。**

1. `skill_view("planning-with-files")` + `skill_view("edgeever-fork-development")`
   （⚠️ 唔使 load test-driven-development / codebase-cli —— 呢轮唔写代码；⚠️ **冇 edgee-mcp skill**，MCP 工具直接用）
2. 确认 registry `active_project: edgeever`
3. 读本文件三处（其余唔使读）：
   - 顶部 **Current Phase** + **「Phase 15 实施实绩」表** → 知道交付咗咩、门禁数字
   - **「关键路径」章** → 分支 / 回滚锚点 / 索引状态
   - **Phase 16 全章** → 16.0 前置 + 16.1 十一项验证表 + 16.2 REST 手法 + 16.4 结果处理
4. 读 findings.md 最底「2026-09-04 远端部署确认 + Phase 16 验证期必知事实」章（陷阱清单，唔读会踩返旧坑）
5. **由 16.0 开始**：先 REST 读 `/api/health` 确认 `build=33f53658`
   - 若係 `2dfd30ac` → 远端仲係旧版 → **停手报告主人**
6. 逐项做 16.1 十一项，每项做完即刻写 progress.md（唔好等最后一次过写）
7. 结果按 16.4 处理；**任一失败唔准即场改代码**，先做调查 → findings → 交主人批
8. 全部通过 → task_plan Status 改 COMPLETED + registry `status: completed` + 告知主人验收完成

**唔准做嘅事**：唔准改代码 / commit / push / 开分支 / 打 tag / docker build / 打 tar；唔准掂主人现有笔记；写操作只用 `DZ_TEST_*` 且测完即清；唔准回显 token 值；唔准 curl 第三方站（只准自己部署嘅 edgee 实例）。

**Status:** 🧪 DEPLOYED — AWAITING REMOTE VERIFICATION（2026-09-04）—— fde-v1.50.0.3 / HEAD 33f53658 已部署运行；Phase 16 待测试 AI 执行。

---

## ⚡ 工作模式规则（主人 2026-09-04 钦定，所有后续 session 遵守）

**背景**：EdgeEver 项目要做嘅嘢多，必须经常用 NIGHT PROVIDER（有折扣）；NIGHT 系列模型响应极慢，纯串行逐个 tool call = 每个调用都等一次大模型响应，「慢到痴线」。所以只要唔会引起大模型并发响应问题，就要尽量把多个 TOOL CALL 一次过批量交俾大模型，避免一个个嚟。

**规则：整体串行，但允许效率型并行/批量**：
- 有数据依赖（下一步要用上一步结果）→ 必须串行
- 无依赖、唔会引起大模型并发响应混乱嘅操作 → **批量一次过申请**（同一 turn 内多个独立 tool call 并行执行）
- 典型可批量：多个只读调查（log 分析 + 源码 grep + 文件读取）、多条独立验证项
- 必须串行：先 health 确认版本先至可以跑后续验证（V0 系闸门）、写操作之间有顺序依赖嘅、破坏性操作
- 数据安全准确优先：批量只用于「互唔影响」嘅操作，唔确定就串行

**Status:** ✅ ACTIVE（2026-09-04 主人确认）

---

## 🔮 Next Version Backlog（2026-09-04 主人钦定，暂缓不实施）

**EdgeEver MCP session 支持改善 —— 消除 keepalive reconnect 垃圾日志**
**【✅ 结案 2026-09-10】**

- • **✅ 噪音已根治（客户端侧）**：Hermes 2026-09-04 升级 V0.21.0（MCP SDK 2.0.0）后，404 body 入面嘅 -32601 被正确识别为 method-not-found，keepalive latch 转 list_tools，reconnect 循环消失。errors.log 实锤：最后一条 keepalive failed = 09-04 07:49，之后零条。完整根因链（EdgeEver 404 + 旧 SDK 硬编码 Session terminated + 新 SDK 解析）见 findings.md 2026-09-10 章
- • **✅ 方案 A 采纳（EdgeEver 加 ping handler）**：MASTER 2026-09-10 批准，交叉验证通过（MCP 规范 optional + MUST empty response；SDK 参考实现 _ping_handler → EmptyResult()）。已纳入 Phase 17.5 实施
- • **❌ 方案 B（完整 Mcp-Session-Id 会话管理）否决**：原始动机消失 + 复杂度高 + serverless 状态管理係坑
- • **🟡 stats 隔离行为查证**：仍待办（两代观察矛盾未解，见 skill SKILL.md stats 条目），纳入 Phase 17.6/18.3 顺带核实；如 Phase 18 后仍无结论，另开专项

## 🔮 升级触发流程（Q3 随缘升级策略，MASTER 2026-09-10 钦定）

- • **触发条件**：MASTER 想要上游新功能 / 上游重大 fix 或安全修复 / 上游 MCP 行为变化影响我哋 patch
- • **固定流程**（今次验证过可复用）：① `git fetch upstream refs/tags/vX.Y.Z`（FETCH_HEAD 方式零 local ref）→ ② diff 规模 + migration 清单 + 共用改动档案交集（comm 命令）→ ③ `git merge-tree --write-tree` 只读冲突探测 → ④ release 区间 commit 主题审查（feat/fix 分布 + 红信号扫描）→ ⑤ 交叉验证最新鲜度（ls-remote main vs tag）→ ⑥ 产出报告交 MASTER 拍板基准版本（红信号可降级次新 tag）
- • **铁律**：升级前必查「上游有无已知新 bug」；merge 永远开新分支唔好直接郁 stable 分支；独立 commit 粒度（merge / 功能 / docs 分开）方便单点 revert

---

## ⏳ 历史存档：Phase 17 实施实绩（2026-09-10，fde-v1.64.0.1 实施组交付；从 80 行窗口移出，记录保留无删除）

**交付物**：HEAD=ce044488（branch+tag fde-v1.64.0.1 已 push，主人已部署）。3 commits = b1b2c1a7 merge upstream v1.64.0 / a6faeca7 feat MCP ping handler / docs DEPLOY V2.4。

**九步实录**：
- ✅ 17.1 分支 fde-v1.64.0.1 自 33f53658（干净开线）
- ✅ 17.2 审查闸门 PASS：100 条 fix 全过目；fix(mcp)=0、security/CVE=0；auth-service/mcp-hiding 家族上游零改动；index.ts 8 个涉及 commit 全部 CORS/agent/plugins 主题（注入点区域没动）；bonus 发现 12f16633「diagram metadata leak」佐证 18.4 审计必要
- ✅ 17.3 merge 0376d768 = merge commit b1b2c1a7，零冲突（实测）；隔离 patch 生存抽查全过
- ✅ 17.4 基线：bun install +153 packages；全库 **1825 pass / 8 fail**（fail 名单与旧基线逐条一致：Docker installer ×3 + Cloudflare ×4 + Wrangler ×1，零新增）；typecheck ×2 + build:web + docker-release 8/0 全绿
- ✅ 17.5 ping TDD：RED 2 fail 正确（Expected 200 Received 404）+ 2 安全网 pre-pass → GREEN 13/13；**TDD 揪出 notification 边界缺口**（无 id ping 应返 202 非 200，已加 isNotification→null 处理）；MCP 回归 16/0 + typecheck 绿
- ✅ 17.6 diagram 隔离审计 PASS：三工具全走 memo-service（写入有 assertNotebookWritable 4 调用点、读取经 wrapper），wrapper 零改动；上游新表（resource_uploads/companion_*）零内容表关联，无泄露面；8 hiding 档 97/0
- ✅ 17.7 全门禁：全库 **1829/8**（+4=新增 ping 测试；8 fail 名单=基线）；泄露矩阵 15/0；BUG-001/002/002b/003 探针全绿；tag-service 融合验证 6/0
- ✅ 17.8 交付：branch+tag 分开 refspec push；ls-remote 核对一致
- ✅ 17.9 DEPLOY_REMOTE_BUILD_V2.md 升 V2.4；全文 28 处旧版本号逐个判定零漏改

**关键决策记录**：① migration 撞号最终定案=唔 renumber（runner 完整档案名 tracking，上游 runner diff 实证 migration loop 没动）② ping 放 auth 之后同 method 分发链同级 ③ ping notification（无 id）返 202 空 body（TDD 实测发现）④ diagram 新工具隔离自动继承无需加规则

**DEPLOY 修正史（主人两轮批评驱动）**：
- 第一轮：migration 计数表述错误（「0037-0046 共 11」→ 实际 = 上游 0036_resource_multipart_uploads + 0037-0046 十个 = 11 行；我哋 0036_mcp_token_hidden 远端已应用会 skip）
- 第二轮（主人批评①）：DEPLOY 完全冇考虑远端既有固定版本仓库 —— 补「第一步：获取源码」双场景（场景 A 既有仓库升级 = 主人指定三连命令 git fetch origin --tags / git checkout fde-v1.64.0.1 / git pull origin fde-v1.64.0.1，实测可行，detached HEAD 属正常现象；场景 B 首次 clone）+ clobber/divergent 排障（实测恢复法：git tag -d 后重跑）
- 第二轮（主人批评②）：build 命令占位符「<部署通知嘅commit hash>」不可执行 —— 先写死 hash，发现自指死循环（docs commit 写死自己 hash，每次 amend 即过期），最终改用 git describe --tags --exact-match 验证 + BUILD_ID=$(git rev-parse HEAD) 自动填，**永远自洽**
- 端到端终验：全新 /tmp clone → 场景 A 三步 → describe=fde-v1.64.0.1 → BUILD_ID 命令实测正确
- 教训固化：① 部署文档必须覆盖「既有部署升级」场景；② 命令必须写死或自洽，占位符=废纸；③ docs 内唔好写死 docs 自身 hash（自指死循环），验证用 tag + commit 主题

**hash 变动史（docs amend 数次，最终=ce044488 后冻结）**：4a382bf0 → 14386658（migration 计数修正）→ 66ceff83（场景 A + 可执行命令）→ af5b67ff（排障章）→ ce044488（斩自指）。验证认住 tag fde-v1.64.0.1。

**DEPLOY V2.4 诚实标注**：0046 migration 有一次性 UPDATE notebooks（inbox 规范化）—— 回滚不还原但无破坏性（逐条核实 0037-0045 ALTER 全落新表、唯一动旧表嘅就係呢条）。

**本 session 零遗留**：无 untracked 文件、无 600 权限新文件、PWF 三文件不入 git（exclude 生效）、工作树干净。

---

## ⏳ 历史存档：Phase 15 实施实绩（2026-09-04，v1.50.0.3 era 已完结；从 80 行窗口移出 2026-09-10，记录保留无删除）

| 步骤 | 实测结果 |
|------|---------|
| 15.0 baseline | 1200 pass / 8 fail / 1208 tests / 251 files ✅ 与计划一致 |
| 15.0b 开分支 | fde-v1.50.0.3 自 6ed18778 ✅ |
| 15.1 RED-1 | 4 pass / 4 fail ✅ T1-T4 FAIL 原因正确（空分类/无 content 行缺失，非 SQL 语法错） |
| 15.2 GREEN-1 | 新档 8/0；8 hiding 档 **100 pass / 2 fail**，两条正好係计划列出嘅（mcp-hiding.test.ts:220 + mcp-hiding-real-sqlite.test.ts:371），无第 3 条 ✅ |
| 15.3 断言升级 | 8 hiding 档 **102/0**；连新档 **110/0** ✅ |
| 15.4 RED-2 | 1 pass / 5 fail ✅ T9-T13 因返回 bare number 而非 outcome object 而 FAIL；T14 dryRun 照旧 PASS |
| 15.5 GREEN-2 | T9-T14 **6/0** 全绿 ✅ |
| 15.6 门禁 | 全库 **1214 pass / 8 fail / 1222 tests / 253 files**，fail 名单逐条对上 baseline（Docker installer ×3 + Cloudflare ×4 + Wrangler ×1）；typecheck ✅ typecheck:mobile ✅ build:web ✅；docker-release 7/0 ✅；600 权限扫空 ✅；隔离探针 8 项全对 ✅；BUG-003 探针 5 case 全对（含 silent-loss → `{updated:2,verified:false,remainingOldTag:2}`）✅ |
| 15.7 交付 | 3 commit + branch/tag 分开 refspec push；`git ls-remote` 核对 HEAD = 33f5365814caf5f6c9276ab8e14da452dfe05746 ✅ |

**实施期唯一计划偏差（已处理，非缺陷）**：新档 T7 原规格用正向断言 `toEqual(["nb_empty","nb_ok"])`，
但咁样 T7 喺 RED 阶段会一齐红（依赖修复才 pass），违反「T5-T8 前后都 PASS 做安全网」嘅设计意图。
已改成**纯负向断言**（`not.toContain("nb_hidden")` / `not.toContain("nb_hidden_empty")` + memos 只得 m_ok），
正向存在性由 T1 独立负责。改动后 RED 阶段 T5-T8 全 PASS，符合原意图。

**2 个 repro 脚本已按 Q7 转正式资产并 commit**，实测已转 after-fix 行为（TEST2 PASS、DIAG 打印 NULL-safe 片段），与 header 写明嘅预期一致。









