# EdgeEver 远端 Git Clone + Build 部署教程（V2.8 — 远端 git clone + docker build）

> 📅 2026-11-08 | 本次部署目标：**分支 fde-v2.23.0.1（上游 merge v2.23.0 + A 点 wrapper 修复 + poster_render_jobs 隔离 + Plan D poster guard）**
> 回滚锚点：**tag fde-v1.90.0.1（292718d0）** 首选 / **tag fde-v1.65.0.1（05c8062f）** 次选 / **tag fde-v1.50.0.3（33f53658）** 三选 | 适用本次及未来所有版本

> ⚠️⚠️ **本版最大风险：37 个新 migration（0056-0092），其中 5 个会改写既有数据 + 1 个会 DROP 表。**
> **没有备份 = 不可回滚。升级前必须先做第 9.1 章嘅 DATA 备份并校验通过，否则唔准升级。** ⚠️⚠️

> 🔄 **交付方式定案（2026-09-04，以后一律照此）**：本地 build → `docker save` → tar.zst → scp 传输**永久废弃**。
> 唯一流程：**远端 git pull → 远端 docker build → 本地镜像 → compose 使用**。实测 clone 体积约 35MB。
> AI 交付物只有两样：**commit hash + 面向用户嘅变更说明**，唔再交任何镜像文件。

> **版本变更记录**
>
> - **V2.10（2026-11-08）**：🔐 **备份格式对齐 MASTER 最新成功案例（v1.65.0.1 实测验证）**。改动三点：① 备份文件名由 `edgeever-data-backup-<TS>.tar.gz` → **`edgeever-data-bak-<目标版本>-<YYYYMMDD>.tar.zst`**（带版本号，回溯清晰；例 `edgeever-data-bak-fde-v2.23.0.1-20261108.tar.zst`）；② 压缩工具 gzip → **zstd**（`tar -I 'zstd -T0 -3' -cpf`），校验改 `zstd -dc | tar -t`，还原改 `zstd -dc | tar -xp`；③ 第零步新增 **zstd ≥ 1.4 前置依赖检查**（体检项 4，apt install 清单同步加 zstd）。**临时区 sandbox 实测通过**：create → `zstd -dc | tar -t` 枚举 → 文件计数 → `.db` grep 全链路可用（zstd 1.5.7 / GNU tar 1.35，`-I` 参数经 `tar --help` 核实）。
> - **V2.9（2026-11-08）**：🧹 **补齐「Build 完成后释放空间」章节（MASTER 要求）**。改动四点：① 原「第五步」重编为 **第四步**（原文编号由第三步直接跳第五步，缺第四步），并大幅扩写为 8 小节（占用判读 / build cache / 悬空+旧镜像 / `docker system prune` 陷阱 / 源码残留 + `git gc` / Bun cache / 一键脚本 / 回收量参考表）；② 日常升级流程新增 **第 7 步「释放空间（必做）」**——原文 1-6 步之后**冇任何清理指引**，流程断点；③ **参数实测更正**：`--keep-storage` 已废弃（Docker 29.x 实测提示 `keep-storage flag has been changed to reserved-space`）→ 改用 `--reserved-space` / `--max-used-space` / `--min-free-space`；④ 修正两处失效引用（第 57 行 / 第 163 行「见第五步」→「见第四步」）。新增安全红线：**绝对唔好**跑 `docker system prune -a --volumes -f`（`-a` 会删回滚镜像、`--volumes` 会删同机其他服务 named volume，不可逆）。
> - **V2.8（2026-11-08）**：目标版本 v1.90.0.1 → **v2.23.0.1**（clone 分支 / build 命令 / .env 示例 / 日常升级步骤 / 回滚锚点全部同步）。本次为**超大版本 merge**（v1.90.0 → v2.23.0，上游 **964 commits / 2402 files / 跨 33 个 minor**）。**新增 37 个 migration（0056-0092）**，其中 ⚠️ **5 个会改历史数据**（0058 / 0059 / 0070 / 0071 / 0078）+ ⚠️ **0064 会 DROP 5 张表**（video transcription 退役，属上游未发布功能）—— 升级前**必须**备份 data（见第 9.1 章 HARD-GATE）。⚠️ **build stage 新增 chromium + nodejs 安装**（上游 Dockerfile，仅 build 机器用；**runtime 镜像零 chromium 零 node**）→ 首次 build 会下载约 200-250MB、慢 +3-8 分钟属正常。本 fork 额外加 **Plan D pre-flight guard**（`RUN bun run check:poster:thumbnails`）：若 poster 缩图 stale，build 会在几秒内 fail-fast 并打印修复指引。本版 FDE 修复：**A 点** `isReadQuery()` 不再把 `WITH...UPDATE` 误判为读查询（TDD 10 断言）+ **Q4** `poster_render_jobs` 加入 hiding wrapper（S11）。验证矩阵新增 **V9 = poster_render_jobs 隔离验证**。
> - **V2.7（2026-09-29）**：目标版本 v1.65.0.1 → **v1.90.0.1**（clone 分支 / build 命令 / .env 示例 / 日常升级步骤 / 回滚锚点全部同步）。本次为**大版本 merge**（v1.65.0 → v1.90.0，上游 25 个 release / 391 commits / 785 files）。**新增 9 个 migration（0047-0055）**，其中 ⚠️ **0047 改 AI prompts seed（升级后 AI 行为会变）** + ⚠️ **0053 一次性 DDL 动 inbox 表** —— 升级前必须备份 data（V2.5 铁律）。新泄露面 `table_forms`（0055）已加入 hiding wrapper（MEMO_ID_SUBQUERY），agent 隐藏 memo 嘅公开表单 404（Q4）。上游新功能：结构化表格笔记 + 表单收集（beta）/ AI Agent 模式全面升级（resumable runs / timeline）/ 公开分享密码保护 / 插件市场本地化。验证矩阵新增 **V8 = table_forms 隔离验证**。
> - **V2.6（2026-09-11）**：目标版本 v1.64.0.1 → **v1.65.0.1**（clone 分支 / build 命令 / .env 示例 / 日常升级步骤 / 回滚锚点全部同步）。本次为**小版本 merge**（v1.64.0 → v1.65.0，上游 10 commits / 118 files），**无新增 migration**（数据库 schema 不变）；新增 F18-A 修复（HiddenNotebookError extends AppError，REST 写隐藏分类 500→403）；TokenHidingEditor bg-white→bg-card 同步上游 dark mode CSS token 重构；上游新功能：Markdown ZIP export + Diagram 布局 4 连 fix + Docker entry path 兼容。
> - **V2.5（2026-09-10）**：⚠️ **新增 DATA 目录强制备份步骤（MASTER 钦定，升级铁律）**——大架构升级（如 v1.64.0.1 嘅 11 个新 migration）会改数据库结构，升级前必须先备份 `./edgeever-data`，否则新版本有问题时**回滚都救唔返数据**；插入位置 = 日常升级流程第 2.5 步（更新源码之后、build/上线之前）+ 升级铁律段；「回滚特殊注意」补充「DATA 备份先至係真正嘅回滚保障（镜像回滚只救代码，唔救数据）」。
> - **V2.4（2026-09-10）**：目标版本 v1.50.0.3 → **v1.64.0.1**（clone 分支 / build 命令 / .env 示例 / 日常升级步骤 / 回滚锚点全部同步）；⚠️ 本次为**大版本 merge**（v1.50.0 → v1.64.0，上游 263 commits），首次启动会自动应用 11 个新 migration（上游 0036_resource_multipart_uploads + 0037-0046 十个），`/api/health` 嘅 migration 字段会变为 0046；新增「回滚特殊注意（schema 变化）」章节；新增 .env 可选新变量说明（全部可唔改）。
> - **V2.3（2026-09-04）**：目标版本 v1.50.0.2 → **v1.50.0.3**（build 命令 / .env 示例 / 日常升级步骤 / 回滚锚点全部同步）；明确交付方式定案（永久唔再打 tar）；新增「BUG-003 `verified` 字段说明」章节（调用方见到 `verified:false` 应自行重试）；新增本版修复内容与验证重点。
> - **V2.2（2026-09-02）**：修正 V2.1 残留错误——第二步 build 命令及 .env 示例版本号 v1.50.0.1 → **v1.50.0.2**（BUILD_ID 改用 commit hash）；迁移验证改用 /api/health 的 migration 字段（实际日志字样为 `[self-hosted] applied migration 0036_...`，唔含 "migration" grep 友好词）；升级流程加入 fetch --tags；回滚步骤改为 `git checkout fde-v1.50.0.1`（实测 single-branch clone 自带全部 tag，无需额外 fetch）；补回滚到任意旧版通用步骤；明确「.env 改版本号 + docker compose up -d」即可重建容器。
> - **V2.1（2026-09-02）**：新增「第零步：前置环境体检」；升级流程加入 dirty tree 处理与 commit hash 校验。
> - **V2.0（2026-09-02）**：取代预 BUILD tar.zst 传输 → 远端 git clone + docker build。

## 🎯 前提条件

- 远端服务器已装 Docker + docker compose plugin
- 能访问 GitHub（github.com/fde-lander/edgeever 是公开 fork）
- 已有 .env（EDGE_EVER_AUTH_PASSWORD 等）

---

## 🔍 第零步：前置环境体检（首次部署前必做）

**需要安装嘅工具**（只需四项，**唔需要**装 bun/node/pnpm——build 全部喺容器内进行）：

1. **Docker Engine** ≥ 20.10（含 buildx 多阶段 build 支持）
2. **git** ≥ 2.20
3. docker compose plugin（docker compose version 可验证）
4. **zstd** ≥ 1.4（⚠️ 备份用 `.tar.zst` 压缩，冇装就做唔到备份）

一键体检脚本（复制即贴）：

    echo "=== 1. Docker 版本 ==="
    docker --version || echo "❌ 未装 Docker"
    echo "=== 2. Compose plugin ==="
    docker compose version || echo "❌ 未装 compose plugin"
    echo "=== 3. git ==="
    git --version || echo "❌ 未装 git"
    echo "=== 4. zstd ==="
    zstd --version || echo "❌ 未装 zstd（备份必需）"
    echo "=== 5. 磁盘空间（build 峰值需 4-6GB）==="
    df -h / | tail -1
    echo "=== 6. GitHub 连通 ==="
    git ls-remote https://github.com/fde-lander/edgeever.git HEAD >/dev/null 2>&1 && echo "✓ GitHub 可达" || echo "❌ GitHub 不可达"

**体检判读**：

- 第 1-4 项任何 ❌：先装对应工具（Debian: apt install docker.io docker-compose-plugin git zstd，Docker 官方源更佳）
- 第 5 项可用空间 < 6GB：先做第四步清理（见第 320 行「Build 完成后释放空间」），或先删旧版镜像
- 第 6 项 ❌：检查 DNS/防火墙（只需 443 出站）

**版本锚点说明**：

- **本次部署 = fde-v2.23.0.1 分支**（上游 merge v2.23.0 + A 点 wrapper 修复 + poster_render_jobs 隔离 + Plan D guard）
- 分支 fde-v2.23.0.1 = fde-v1.90.0.1（292718d0）→ merge upstream v2.23.0（6600a632）→ A 点修复 + Q4 poster rule + Plan D guard
- tag **fde-v1.90.0.1（292718d0）** = 上一个可用版本（远端而家跑紧），**首选回滚锚点**
- tag fde-v1.65.0.1（05c8062f）= 更早稳定版，次选回滚锚点
- tag fde-v1.50.0.3（33f53658）= 老稳定点，三选回滚锚点
- v1.90.0.1 → v2.23.0.1 **有大规模 schema 变化**：上游带来 **37 个新 migration（0056-0092）**。**首次启动自动应用，无需手动 migrate**；⚠️ migration 撞号（上游 0036_resource_multipart_uploads vs 我哋 0036_mcp_token_hidden）无害——runner 按完整档案名 tracking，两者都会被正确应用一次（我哋嗰条远端已应用过会 skip，上游嗰条会执行）

**⚠️ 本版 migration 风险明细（37 个内最需注意的 6 个）**：

| migration | 影响 | 如何判断有无影响 |
|---|---|---|
| `0058_retire_emerald_note_palette` | UPDATE users.note_prose_palette（emerald→native） | 若你从未用过翡翠色板 → 零影响 |
| `0059_retire_custom_note_palette` | UPDATE users（custom→native） | 若从未用过自定义色板 → 零影响 |
| `0064_retire_video_transcription` | **DROP 5 张表**（video transcription 退役） | 若从未用过视频转写 → 零影响 |
| `0070_workspace_seed_localization` | 只在「完全未用过」安装生效 | 有数据 → 自动跳过 |
| `0071_fix_welcome_memo_markdown` | 只动 hash 完全匹配的 welcome seed | 你改过 welcome note → 自动跳过 |
| `0078_clear_default_notebook_colors` | 只清 untouched 出厂色值 | 自订过外观 → 保留原值 |

**本版变更内容（v2.23.0.1）**：

1. **上游 merge v2.23.0**：v1.90.0 → v2.23.0（**964 commits / 2402 files / 跨 33 个 minor**）：新增 **16 个 MCP 工具**（poster 8 / table 7 / 其他 2，旧 45 → 61）/ poster 设计渲染 / 结构化表格笔记增强 / 视频转写退役（0064）/ 笔记本外观（颜色/粗体/文字色/反色）×4 migration / TOTP 双因素认证 / 公开笔记本站点 / 笔记分享 slug + 密码 + 展示选项 / 备份 revision / 定时任务运行计数 / 导出游标索引 / 4 个安全修复（XSS 修复 / renderer 边界加固 / 依赖漏洞更新 / URI+SVG 漏洞更新）
2. **A 点修复（本版 FDE 核心改动 1）**：`isReadQuery()` 不再把 `WITH ... UPDATE/INSERT/DELETE` 误判为读查询 —— 上游 `deleteNotebookTree` 的 guarded UPDATE 之前会被送进 `rewriteSelectSql()` 并被错误注入。**TDD 修复**（`tests/mcp-hiding-with-update.test.ts` T1-T7，RED 4 fail → GREEN 10 pass）
3. **Q4 poster_render_jobs 隔离（本版 FDE 核心改动 2）**：`poster_render_jobs`（0066）加入 hiding wrapper（MEMO_ID_SUBQUERY，NULL-safe）—— `readPosterRenderJob()` 直接 SELECT 本表且无 JOIN memos，之前 agent 可读/轮询隐藏 memo 的渲染任务（template / revision / status 全泄露）。**TDD 修复**（`tests/mcp-hiding-poster-jobs.test.ts` T1-T5，RED 3 fail → GREEN 5 pass）+ leak-matrix S11
4. **Plan D poster guard（本版 FDE 核心改动 3）**：Dockerfile 保留 upstream 原样（chromium 5 行全部不动）+ 加独立一行 `RUN bun run check:poster:thumbnails`，stale 时 fail-fast 而非静默跑浏览器
5. **隔离功能全量保留**：per-token 隔离、NULL-safe 修正（BUG-002/002b）、search 修复（BUG-001）、tag verified 字段（BUG-003）、F18-A（REST 403）全部喺 merge 后实测回归通过（hiding 全套 10 档全绿 + leak-matrix 19 pass / 0 fail + 全库 2428 pass / 11 fail = baseline 环境相关 11 条零新增）
6. **Q3 判定（已实测安全，不加守卫）**：`delete_notebook` 递归删除对 agent 天然安全 —— wrapper 过滤隐藏子树导致计数不匹配 → `changes=0` → 409 拒绝。**隐藏数据永不落入 UPDATE 的 id 集合**（3 场景探针实测）


---

## 📦 第一步：获取源码

📌 **两种场景二选一**：远端已有一个旧版 edgeever 源码仓库（今次及以后大部分情况）→ 用 **场景 A**；全新机器 / 换目录 → 用 **场景 B**。

### 场景 A：既有仓库升级（默认 —— 远端已有 fde-v1.90.0.1 等旧版仓库）

喺既有源码目录（例如 /opt/edgeever-src）逐条执行：

    git fetch origin --tags
    git checkout fde-v2.23.0.1
    git pull origin fde-v2.23.0.1

核对（两条都应通过）：

    git log --oneline -1
    # 应显示：docs: DEPLOY V2.8 for fde-v2.23.0.1（或用 git describe --tags --exact-match 确认输出 fde-v2.23.0.1）
    git describe --tags --exact-match
    # 应输出：fde-v2.23.0.1

**排障**：如果 fetch 报 `! [rejected] ... (would clobber existing tag)` 或 pull 报
`Need to specify how to reconcile divergent branches` —— 只会喺「之前 fetch 过旧版同名 tag」
嘅仓库出现（例如 AI 部署通知前曾拉过一次）。恢复法（实测 2026-09-10）：

    git tag -d fde-v2.23.0.1
    git fetch origin --tags
    git checkout fde-v2.23.0.1
    git pull origin fde-v2.23.0.1
    git describe --tags --exact-match    # 应输出 fde-v2.23.0.1

⚠️ **HEAD detached 说明**：单分支 clone 入面 checkout 新分支名时，git 找不到同远端 tracking 分支但找到同名 tag，会落在「HEAD detached at fde-v1.90.0.1」—— **呢个係正常现象唔係错误**（实测 2026-09-10）：docker build 只需要源码文件树，detached 状态文件齐全、build 无影响。以后升级更新版本时同样三步（checkout 新版本号）即可。

⚠️ dirty tree 处理：checkout 前先检查

    git status --porcelain

应输出空（远端纯 build 目录正常永唔会有本地改动）。如有输出（意外改动），先 stash 保存唔好删：

    git stash push -m "pre-update-$(date +%s)"

### 场景 B：首次 Clone（全新机器 / 新目录先用）

1. 选个目录，例如 /opt/edgeever-src：

       git clone --branch fde-v2.23.0.1 --single-branch https://github.com/fde-lander/edgeever.git /opt/edgeever-src

2. 验证 HEAD commit：

       cd /opt/edgeever-src && git log --oneline -1

   应显示：docs: DEPLOY V2.8 for fde-v2.23.0.1（可用 git describe --tags --exact-match 确认输出 fde-v2.23.0.1）

   注：`--single-branch` clone 默认已带全部 tags（git 默认 --tags 跟 clone 走），无需额外 fetch tag 即可 checkout 旧 tag 回滚。

3. ⚠️ **权限说明**：如果系 root 执行 clone，文件 owner 系 root，对纯 build 场景冇问题
   （build 喺容器内 COPY 处理，运行容器 USER bun 只读镜像内文件，唔读源码目录）。

---

## 🏗 第二步：远端 Build 镜像

在源码目录（/opt/edgeever-src）执行（版本号必须与本次部署目标一致 = **v2.23.0.1**）：

    docker build \
      --build-arg EDGE_EVER_BUILD_ID=$(git rev-parse HEAD) \
      -t edgeever-fde:v2.23.0.1 \
      .

要点：
- BUILD_ID 用 $(git rev-parse HEAD) 自动填当前 HEAD 全 hash —— /api/health 嘅 build 字段 = 拉到嘅源码 commit 前 12 位，**永远自洽**（唔使手抄 hash，唔会抄错）
- `-t` 标签名自定，与 .env 的 EDGE_EVER_IMAGE / EDGE_EVER_VERSION 对应即可
- 首次 build 要下载 oven/bun:1.3.14-alpine 基础镜像 + bun install 全部依赖，耗时较长（视网络 5-20 分钟）
- 磁盘需求：build 过程峰值约 4-6 GB，build 完**必须清理**（见第四步「Build 完成后释放空间」）

验证镜像存在：

    docker images | grep edgeever

---

## 🔧 第三步：compose 指向本地 build 镜像

仓库自带的 compose.yaml 默认拉 ghcr.io 官方镜像，本地 build 要用 .env 覆盖。

在 compose 文件同目录建 .env（如果已有就改）：

    EDGE_EVER_IMAGE=edgeever-fde
    EDGE_EVER_VERSION=v2.23.0.1
    EDGE_EVER_PORT=8787
    EDGE_EVER_AUTH_USERNAME=admin
    EDGE_EVER_AUTH_PASSWORD=你的密码

注意 compose.yaml 用 "image: ${EDGE_EVER_IMAGE}:${EDGE_EVER_VERSION}"，
所以 EDGE_EVER_IMAGE=edgeever-fde + EDGE_EVER_VERSION=v2.23.0.1 会拼出 edgeever-fde:v2.23.0.1，
正好对应第二步的 -t 标签。

**⚙️ .env 可选新变量（v1.64.0 上游新增，全部唔改都照样跑）**：

上游 runner 新增 credential secrets 自动管理（首启自动喺 data volume 生成加密 key，2026-09-04 上游实锤 a853c923 fix(docker) persist credential encryption secrets on the data volume —— **已有 data volume 就自动持久化，唔使做嘢**）。可选环境变量：

    # 仅当你想手动指定 credential 加密 key 先加（一般唔使）
    # EDGE_EVER_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS=旧key轮换时用
    # EDGE_EVER_AUTH_PASSWORD_FALLBACK=旧密码轮换过渡期用

⚠️ 如果你用独立目录管理 compose（如 /opt/edgeever），唔使用源码目录的 compose.yaml，
可以复制一份过去：cp /opt/edgeever-src/compose.yaml /opt/edgeever/
数据卷 edgeever-data 独立于源码目录，升级重 build 唔影响数据。

启动/更新（.env 改好版本号后 up -d 会自动重建容器）：

    docker compose up -d

验证健康（应返回 "ok": true、"migration":"0055_..."、"build":"<本次 commit hash 前 12 位>"）：

    curl -s http://127.0.0.1:8787/api/health

⚠️ 首次启动 v1.90.0.1 时会自动应用 9 个新 migration，启动日志应有 9 行
`[self-hosted] applied migration ...`：由 `0047_replace_social_ai_prompts.sql`
一路到 `0055_table_forms.sql`。（0047 会替换 AI prompts seed + 0053 系一次性 DDL
动 inbox 表 —— 升级前必须备份 data，见日常升级流程 2.5 步。）

---

## 🔁 日常升级流程（以后每个新版本照此，本次 = v1.90.0.1 → v2.23.0.1）

1. 本地 AI 改完代码 push 到 GitHub 分支，并告知**新 commit hash**（每次升级都用通知嘅 hash 校验，唔好凭记忆拉）
2. 远端更新源码：

       cd /opt/edgeever-src
       git fetch origin --tags
       git checkout fde-v2.23.0.1
       git pull origin fde-v2.23.0.1
       git log --oneline -1     # 应与通知的 HEAD 一致，唔一致就停手

   ⚠️ 本版分支係**新分支**（之前係 fde-v1.90.0.1），`git checkout` 会自动切换，属正常。

2.5. ⚠️⚠️ **DATA 目录强制备份（本版最高风险步骤 — HARD-GATE）**

    本版新增 **37 个 migration（0056-0092）**，其中 **5 个会改写既有数据**、
    **1 个会 DROP 5 张表**。冇备份 = 出事之后**连回滚都救唔返数据**。

    ⚠️ **唔备份唔准升级**。

    **备份命名格式（MASTER 钦定，沿用 v1.65.0.1 成功案例）**：
    `edgeever-data-bak-<目标版本>-<YYYYMMDD>.tar.zst`
    例：`edgeever-data-bak-fde-v2.23.0.1-20261108.tar.zst`

       # ① 停容器（SQLite 一致性要求，不能热备）
       cd /opt/edgeever        # ← compose 所在目录（按你实际路径）
       docker compose stop edgeever

       # ② 整份备份（zstd 压缩，多线程，保留权限）
       BAK="edgeever-data-bak-fde-v2.23.0.1-$(date +%Y%m%d).tar.zst"
       sudo tar -I 'zstd -T0 -3' -cpf "$BAK" edgeever-data/
       ls -lh "$BAK"

       # ③ ⚠️ 校验备份完整性（不校验 = 不算备份完）
       zstd -dc "$BAK" | tar -t | head -20
       zstd -dc "$BAK" | tar -t | wc -l                              # 应 > 100
       zstd -dc "$BAK" | tar -tv | grep -E '\.db|\.sqlite'           # 应见到 db 文件

       # ④ 记低备份路径（写进部署记录）
       echo "BACKUP=${PWD}/$BAK"

    **判读**：zstd 解压失败 / tar 列出失败 / 文件数 < 100 / 无 .db 文件 → **停手排查，不许继续**。

    ⚠️ 用 zstd 而非 gzip 的原因：实测同体积压缩率更高、`-T0` 多线程快 3-5 倍，data 大时省很多时间。
    ⚠️ 本项目已是 **bind mount**（`./edgeever-data:/data`），**唔好用 `docker volume inspect`**（Phase 14 已从 named volume 迁走）。

3. 重新 build（BUILD_ID 自动填当前 HEAD）：

       docker build --build-arg EDGE_EVER_BUILD_ID=$(git rev-parse HEAD) -t edgeever-fde:v2.23.0.1 .

   ⚠️⚠️ **本版 build 会明显变慢，属正常，唔好误判为卡死**：

   - 上游 v2.23.0 Dockerfile 的 **build stage 新增 `chromium` + `nodejs` 安装**（`apk add --no-cache chromium nodejs`）
   - **首次 build 会下载约 200-250MB**，预计 **慢 +3-8 分钟**
   - `apk add` 在 `COPY apps/api` 之前 → **Docker 层缓存可复用，第 2 次起不再下载**
   - ✅ **runtime 镜像（生产环境跑的）零 chromium、零 node** —— 全新 `FROM oven/bun:1.3.14-alpine`，实测 runtime 段 grep chromium = 0
   - 即：**服务器上跑的镜像绝对没有浏览器**；chromium 只在 build 机器上，为「万一 poster 缩图过期」的防御

   ⚠️ **本 fork 另加了 Plan D pre-flight guard**（`RUN bun run check:poster:thumbnails`）：

   - 若 poster 缩图 **fresh**（v2.23.0 属此情况）→ guard 几秒内通过，**build 根本不会启动浏览器**
   - 若 poster 缩图 **stale**（未来上游某版忘同步）→ guard **立刻 EXIT=1 fail-fast**，报 `Poster thumbnails are stale`，**唔会静默跑 5-10 分钟浏览器最后可能 OOM**
   - 遇到此错误照下面修复后重新 build：

         # 在源码目录（/opt/edgeever-src）执行：
         bun run prepare:poster:thumbnails
         git add apps/web/src/assets/poster-template-previews
         git commit -m "chore: regenerate poster thumbnails"

     若远端冇装 bun，可跳过此路径，改用官方 Dockerfile 原本的 build 内生成（去掉 guard 那行临时构建）。

4. 改 .env 版本号 → 重建容器：

       # .env 入面：EDGE_EVER_VERSION=v2.23.0.1
       docker compose up -d

5. 验证（健康端点 + 本次变更重点）：

       sleep 20 && curl -s http://127.0.0.1:8787/api/health
       # 应返回 "ok":true、"migration":"0092_..."（37 个新 migration 自动应用）、"build":"<新 HEAD 前12位>"

**本次升级（v1.90.0.1 → v2.23.0.1）验证重点（V0-V10）**：

- **V0** `/api/health`：`build` = 新 HEAD 前 12 位，**`migration=0092`**（0056-0092 共 37 个自动应用），`ok:true`，HTTP 200
- **V1** MCP `get_current_user`：owner 身份 + 8 scopes + `dataIsolation workspaceScoped`
- **V2** MCP `list_notebooks`：基线数量（现行 6 个可见分类）
- **V3** MCP `list_memos`：基线数量（现行 36 active）
- **V4** 分类隔离核心：隐藏分类的 memo **不在** 任何 MCP 列表
- **V5** MCP 读隐藏：`get_memo(隐藏id)` → 404
- **V6** MCP 写隐藏：`create_memo` 到隐藏分类 → 403 HiddenNotebookError
- **V7** 标签隔离：隐藏分类的标签不出现在 `list_tags`
- **V8** `get_workspace_stats`：notebooks / memos 数与 V2/V3 一致（隔离过滤生效）
- **V9** ⭐ **poster_render_jobs 隔离（本版新增）**：
  - agent 对**隐藏分类**的 poster 调 `request_poster_render` → 404 / 403
  - agent 拿**隐藏 jobId** 调 `get_poster_render_job` → **404**（唔暴露存在性）
  - agent 对**可见** poster 调 render → 正常返回 job（功能未被隔离误杀）
- **V10** Diagram / Table / Form 隔离回归：隐藏分类的 diagram / table_forms 对 agent 一律不可见
- 被隔离分类仍然完全不可见 —— 隔离功能未被上游 merge 削弱
- `search_memos`（BUG-001）/ `create_notebook`（BUG-002）/ `rename_tag` 返 `verified:true`（BUG-003）/ F18-A（REST 写隐藏 403）四条修复全部无回归
- **MCP 工具列表应为 61 个**（上游 v2.23.0 新增 16 个：poster 8 / table 7 / 其他 2，旧 45 → 61）

⚠️ **测试数据铁律**：只用 `DZ_TEST_*` 前缀新建数据，**绝对不碰现有笔记**，测完即清。

6. 旧镜像确认新版运行正常后可删（**先确认新版全绿再删**）：

       docker rmi edgeever-fde:v1.90.0.1

   ⚠️ **本版建议保留旧镜像 + 备份至少 72 小时**（37 个 migration 风险面比上次大 4 倍）。

7. 🧹 **释放空间（必做，每次升级都要做，唔好跳过）**：

   ⚠️ **顺序铁律**：**必须系上面 1-6 步全绿（尤其第 5 步 `/api/health` 验证通过）之后**才做。
   如果验证未过就清 cache，一旦要回滚/重建，就要从头再下载 chromium + nodejs + 全部依赖，白等 10-20 分钟。

       # ① 睇占用（判断清边样）
       docker system df

       # ② 清 build cache（最大回收项，3-6 GB；保留最近 2GB 让下次 build 快返）
       docker builder prune --reserved-space 2GB -f

       # ③ 清悬空镜像
       docker image prune -f

       # ④ 确认回收效果
       docker system df
       df -h / | tail -1

   **预期**：做齐 ②+③ 一般可回收 **4-8 GB**（本版 Dockerfile 4 阶段 + chromium/nodejs，cache 特别大）。

   ⚠️ **绝对唔好**跑 `docker system prune -a --volumes -f`：
   `-a` 会连你留低做回滚嘅旧镜像都删；`--volumes` 会删同机其他服务嘅 named volume（不可逆）。

   📖 **完整清理指引（含参数实测更正、git gc、Bun cache、判读表）见「第四步：Build 完成后释放空间」第 320 行起。**

---

## 🧹 第四步：Build 完成后释放空间（必做，每次升级都做）

⚠️ **时机铁律**：清理**必须**在「第四步之后」= 新版容器已启动 + `/api/health` 验证全绿 + （本版建议）观察无异常之后才做。
**唔好 build 完即刻清 cache** —— 如果验证失败要回滚或重建，cache 清咗就要从头再下载 chromium/nodejs + 全部依赖，白等 10-20 分钟。

---

### 4.1 先睇占用（判断要不要清、清边样）

    docker system df

    # 想睇每条 cache / 每个镜像具体几大：
    docker system df -v

判读：

- **Build Cache** 行 = 本版 build 累积（大头）。本版 Dockerfile 系 4 阶段多 build（manifests → dependencies → build → runtime）+ `apk add chromium nodejs`，
  **单次 build cache 保守估计 3-6 GB**（视之前有无 cache 复用）。
- **Images** 行 `RECLAIMABLE` = 悬空 + 未被容器使用嘅旧版镜像，这部分可以回收。
- **Containers** 行一般 0B（`up -d` 后旧容器会被替换成悬空，会算入 Images）。

---

### 4.2 清 build cache（最大回收项，安全）

    # 全部清（下次 build 变慢但无副作用，数据零影响）
    docker builder prune -f

    # 【推荐】只清旧 cache，保留最近 2GB 让下次 build 快返：
    docker builder prune --reserved-space 2GB -f

    # 或者反过来：限制 cache 总量上限 2GB：
    docker builder prune --max-used-space 2GB -f

⚠️ **参数实测更正（Docker 29.x）**：

- `docker builder prune` 现在实际系 `docker buildx prune` 嘅别名（`docker builder prune --help` 会显示 `Usage: docker buildx prune`）。
- **旧写法 `--keep-storage` 已废弃** —— 实测会打印 `Flag --keep-storage has been deprecated, keep-storage flag has been changed to reserved-space`（唔会报错，但唔好再用）。
- 正式写法：`--reserved-space`（永远保留几多）/ `--max-used-space`（上限几多）/ `--min-free-space`（清到剩几多空闲）。
- 加 `-a` 会连 internal/frontend images 都清（更彻底，一般都无害）。

---

### 4.3 清悬空 + 旧版镜像

    # 只删 dangling（<none> 标签嘅中间层镜像），最安全
    docker image prune -f

    # 睇下边个系旧版
    docker images | grep edgeever-fde

    # 确认新版全绿之后再删旧版（本版强烈建议保留至少 72 小时）
    docker rmi edgeever-fde:v1.90.0.1

⚠️ **本版（37 个 migration）保守做法**：`v1.90.0.1` 旧镜像 + data 备份 **至少留 72 小时** 才删。
因为 37 个 migration 风险面比上次大 4 倍，万一 72 小时内发现问题要回滚，有旧镜像 = 回滚快好多。

---

### 4.4 ⚠️ `docker system prune` 嘅陷阱（唔好乱用）

    # ❌ 危险组合，绝对唔好加 -a --volumes
    # docker system prune -a --volumes -f

- `docker system prune -f` 本身只清「停止嘅容器 + 未使用网络 + 悬空镜像 + build cache」→ 对本项目安全。
- **绝对唔好加 `-a`**：会连「有 tag 但冇容器用嘅镜像」都删（包括你留低 72 小时嘅回滚镜像、其他项目镜像）。
- **绝对唔好加 `--volumes`**：会删未挂载嘅 volume。本项目虽然已改 bind mount（`./edgeever-data:/data`，Phase 14），
  但同机可能有其他服务用 named volume，误删 = 灾难。**呢个系不可逆操作，唔好赌**。

结论：本项目只用手动精准命令（4.2 + 4.3），**唔用 `docker system prune -a`**。

---

### 4.5 源码目录残留（正常情况应该系 0）

⚠️ 重点：第二步嘅 `docker build` **全部在容器内多阶段进行**，远端源码目录**唔会**生成 `node_modules`。
除非你曾经在远端直接跑过 `bun install` / `bun run`（**唔好咁做，无必要**）。

检查：

    du -sh /opt/edgeever-src 2>/dev/null
    du -sh /opt/edgeever-src/node_modules 2>/dev/null || echo "✓ 干净，无 node_modules"

如果真系有（曾手动跑过 bun install），清理：

    rm -rf /opt/edgeever-src/node_modules \
           /opt/edgeever-src/apps/*/node_modules \
           /opt/edgeever-src/packages/*/node_modules
    rm -rf /opt/edgeever-src/.bun-cache 2>/dev/null

**顺手压一压 git 仓库**（每次跨大版本 merge 后 packfile 会膨胀，`git gc` 可回收）：

    cd /opt/edgeever-src
    git gc --aggressive --prune=now

    # 睇下省到几多
    du -sh .git

⚠️ `git gc` 只整理 git 内部对象，**绝对安全**，唔会动 working tree 或者 data。

---

### 4.6 Bun 全局缓存（远端本来唔应该装 bun）

纯 `docker build` 部署**唔需要**远端装 bun。如果曾经装过：

    du -sh ~/.bun              # 睇占用
    rm -rf ~/.bun              # 完全移除（会删埋 bun 可执行文件）

或只清 install cache 保留 bun 本体（万一要跑 4.2 嘅 poster thumbnails 修复命令）：

    rm -rf ~/.bun/install/cache

⚠️ **实测参考数据**（本机 2026-11-08 实测，供比对远端是否异常）：

- `~/.bun` 总量 = **3.8 GB**，其中 `~/.bun/install/cache` = **3.7 GB**（几乎全部系 cache）
- edgeever `node_modules` = **3.3 GB**
- 远端用 docker build 方法，呢两项**都应该保持为 0**。如果见到几 GB → 说明有人跑过本地 install，可以清。

---

### 4.7 一键体检 + 清理脚本

**体检（只读，唔删任何嘢）：**

    echo "=== Docker 占用 ==="
    docker system df

    echo "=== 源码目录残留 ==="
    du -sh /opt/edgeever-src 2>/dev/null
    du -sh /opt/edgeever-src/node_modules 2>/dev/null || echo "无 node_modules ✓"

    echo "=== Bun 残留 ==="
    du -sh ~/.bun 2>/dev/null || echo "无 ~/.bun ✓"

    echo "=== 磁盘余量 ==="
    df -h / | tail -1

**清理（新版验证全绿之后才跑）：**

    echo "=== 清 build cache ==="
    docker builder prune --reserved-space 2GB -f

    echo "=== 清 dangling 镜像 ==="
    docker image prune -f

    echo "=== 确认旧镜像可删（72 小时后才做） ==="
    docker images | grep edgeever-fde

    echo "=== 清理后对比 ==="
    docker system df
    df -h / | tail -1

---

### 4.8 预期回收量参考

| 项目 | 典型占用 | 清理命令 | 风险 |
|---|---|---|---|
| Build Cache | 3-6 GB（本版 chromium+nodejs 多阶段） | `docker builder prune` | 零（下次 build 慢些） |
| 悬空镜像 | 数百 MB - 2 GB | `docker image prune -f` | 零 |
| 旧版镜像（72h 后） | 约 200-400 MB/个 | `docker rmi <tag>` | 零（确认新版正常） |
| 源码 node_modules（异常） | 3.3 GB | `rm -rf` | 零（docker build 唔用佢） |
| Bun cache（异常） | 3.7 GB | `rm -rf ~/.bun/install/cache` | 零 |
| git packfile | 数百 MB（跨大版本 merge 后） | `git gc --prune=now` | 零 |

**正常一次升级完了之后，做齐 4.2 + 4.3，一般可回收 4-8 GB。**

---

## ⚠️ 回滚方案（三级，由快到完整）

### Level 1 — 代码快速回滚（⚠️ 只在 migration 未跑完时有效）

    # .env 改 EDGE_EVER_VERSION=v1.90.0.1
    docker compose up -d

⚠️ **限制**：只有容器启动即失败（**migration 未执行完成**）时才有效。
若 migration 已跑完（`/api/health` 显示 `migration=0092`），DB schema 已变，**此回滚会崩**。

### Level 2 — 数据 + 代码完整回滚（⚠️ migration 已执行后的唯一正确方案）

    cd /opt/edgeever

    # ① 停容器
    docker compose stop edgeever

    # ② 先把失败状态留档（唔好直接删，方便事后分析；保留至少 72 小时）
    mv edgeever-data "edgeever-data-failed-$(date +%Y%m%d-%H%M%S)"

    # ③ 还原备份（用第 2.5 步做嘅 .tar.zst 包）
    zstd -dc edgeever-data-bak-fde-v2.23.0.1-<你的日期>.tar.zst | tar -xp
    ls -la edgeever-data/        # 确认还原成功

    # ④ 代码回滚
    cd /opt/edgeever-src
    git checkout fde-v1.90.0.1
    git log --oneline -1         # 应为 292718d0
    docker build --build-arg EDGE_EVER_BUILD_ID=292718d0 -t edgeever-fde:v1.90.0.1 .

    # ⑤ 改 .env → 启动 → 验证
    # .env 入面：EDGE_EVER_VERSION=v1.90.0.1
    cd /opt/edgeever
    docker compose up -d
    sleep 20 && curl -s http://127.0.0.1:8787/api/health
    # 预期：build=292718d0..., migration=0055, ok:true

### Level 3 — 回滚锚点

| 优先级 | 版本 | commit | 备注 |
|---|---|---|---|
| 首选 | `fde-v2.23.0.1` | 本版交付 | 部署成功后备份首可选 |
| **回滚首选** | `fde-v1.90.0.1` | `292718d0` | **现行稳定版**，回滚目标 |
| 次选 | `fde-v1.65.0.1` | `05c8062f` | 更早稳定点 |
| 三选 | `fde-v1.50.0.3` | `33f53658` | 老稳定点 |

### ⚠️⚠️ 回滚特殊注意（本版 37 个 migration，风险面比上次大 4 倍）

本版首次启动会应用 **37 个新 migration（0056-0092）**。其中：

**① 会改写既有数据的 5 个**（单向，回滚唔会还原）：
- `0058_retire_emerald_note_palette` — 退役翡翠色板，**改 users.note_prose_palette 数据**
- `0059_retire_custom_note_palette` — 退役自定义色板（同上）
- `0070_workspace_seed_localization` — workspace 种子本地化（**只在「完全未用过」的安装才会生效**，有数据则跳过）
- `0071_fix_welcome_memo_markdown` — 修 welcome memo markdown（**只动 hash 完全匹配的 untouched seed**，重跑即 no-op）
- `0078_clear_default_notebook_colors` — 清默认 notebook 颜色（**只清 untouched 出厂色值**，自订外观保留）

**② 会 DROP 表的 1 个**（最需注意）：
- `0064_retire_video_transcription` — **DROP 5 张表**：`ai_transcription_workspace_settings` / `ai_transcription_models` / `ai_transcription_providers` / `ai_transcription_settings` / `video_transcript_jobs`
- ⚠️ 这些属上游**未发布功能**（v2.x 期间引入又退役），**正常情况下冇数据**；且 `0065` 会重建 `ai_transcription_providers` / `ai_transcription_models` / `ai_transcription_workspace_settings` 三张（结构更新）
- **如果你的实例从冇用过 video transcription → 影响为零**

**③ 回滚可行性判断**：

| 情况 | 回滚 fde-v1.90.0.1 会否崩 | 说明 |
|---|---|---|
| migration 已跑完（migration=0092） | 可以启动，但 schema 已变 | 旧代码唔识 0056-0092 新表/新字段 → 唔报错唔删数据（只会「多咗但用唔着」） |
| ⚠️ 但 0064 DROP 咗 5 张表 | 旧代码若依赖这些表 → **会崩** | 正常实例冇用 video transcription，无影响；若你真用过 → **必须 Level 2 还原备份** |

**⚠️ 铁律**：
1. **必须先有备份才允许升级**（HARD-GATE，见 2.5 步）
2. **migration 已执行 = 只能 Level 2**，不能只回代码
3. 失败状态目录（`edgeever-data-failed-*`）**保留至少 72 小时**再清理
4. 回滚完成后必须验证 `migration` 字段回到 `0055`，否则 schema 与代码不匹配
5. **永远唔好删除/重建 `./edgeever-data`** —— 会连笔记数据一齐删埋
6. 想再升级返 v2.23.0.1：migration runner 睇 `_edgeever_migrations` 表，0056-0092 已记录为已应用 → 唔会重跑 → 直接照常用，**无数据问题**

---

## 🏷 BUG-003 `verified` 字段说明（v1.50.0.3 新增）

`rename_tag` / `delete_tag`（MCP）同 `PATCH|DELETE /api/v1/tags/:tag`（REST）由本版起
除 `updated` 之外多返两个字段：

- **`verified`**：`true` = 写入后已重读 ground truth 确认旧 tag 消失；`false` = **写入未确认**
- **`remainingOldTag`**：写入后仲有几多条笔记带住旧 tag（`verified: true` 时必为 0）

**为何要加**：旧版 `updated: N` 其实只代表「组装咗 N 条 SQL statement」，`db.batch()` 嘅返回值
被完全丢弃 —— 所以「响应成功但标签实际未改」会静默通过。本版把静默失败变成**可见失败**。

**调用方（AI / 脚本）应该点做**：

- 见到 `verified: true` → 正常，唔使理
- 见到 `verified: false` → **自行重试同一个 rename**（rename 本身幂等，重跑安全），并记录 `remainingOldTag` 数值同时间点
- **唔会抛 409 / 唔会中断流程** —— 咁样批量 20 次 rename 唔会因为一次未确认而全部停低

**诚实标注**：单次真实丢写嘅触发条件**仍未复现**（约 20 次中 1 次）。本修复目标系令问题可见，
**唔承诺消灭**。日后若真见到 `verified: false`，届时会有确切数据（remainingOldTag + 时间点）可以追根因。

---

## 📋 新旧方法对比

- **传输体积**：旧 169MB tar.zst → 新约 35MB git 对象（增量 pull 更快）
- **传输方式**：旧 scp 文件 → 新 git pull
- **本地负担**：旧 本地 build+save+删 image → 新 零
- **远端负担**：旧 docker load → 新 docker build（耗 CPU 5-20min）
- **回滚**：旧 保留多个 tar → 新 git checkout + rebuild
- **磁盘风险**：旧 tar 累积 → 新 build cache 累积（可 prune）