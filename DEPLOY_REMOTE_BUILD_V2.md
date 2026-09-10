# EdgeEver 远端 Git Clone + Build 部署教程（V2.4 — 远端 git clone + docker build）

> 📅 2026-09-10 | 本次部署目标：**分支 fde-v1.64.0.1（上游 merge v1.64.0 + MCP ping handler）**
> 回滚锚点：**tag fde-v1.50.0.3（33f53658）** 首选 / **tag fde-v1.50.0.2（2dfd30ac）** 次选 | 适用本次及未来所有版本

> 🔄 **交付方式定案（2026-09-04，以后一律照此）**：本地 build → `docker save` → tar.zst → scp 传输**永久废弃**。
> 唯一流程：**远端 git pull → 远端 docker build → 本地镜像 → compose 使用**。实测 clone 体积约 35MB。
> AI 交付物只有两样：**commit hash + 面向用户嘅变更说明**，唔再交任何镜像文件。
> （旧 tar 文件 edgeever-fde-v1.50.0.1.tar.zst 同旧教程 DEPLOY_V1.50.0.1.md 已于 2026-09-04 删除。）

> **版本变更记录**
>
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

**需要安装嘅工具**（只需两项，**唔需要**装 bun/node/pnpm——build 全部喺容器内进行）：

1. **Docker Engine** ≥ 20.10（含 buildx 多阶段 build 支持）
2. **git** ≥ 2.20
3. docker compose plugin（docker compose version 可验证）

一键体检脚本（复制即贴）：

    echo "=== 1. Docker 版本 ==="
    docker --version || echo "❌ 未装 Docker"
    echo "=== 2. Compose plugin ==="
    docker compose version || echo "❌ 未装 compose plugin"
    echo "=== 3. git ==="
    git --version || echo "❌ 未装 git"
    echo "=== 4. 磁盘空间（build 峰值需 4-6GB）==="
    df -h / | tail -1
    echo "=== 5. GitHub 连通 ==="
    git ls-remote https://github.com/fde-lander/edgeever.git HEAD >/dev/null 2>&1 && echo "✓ GitHub 可达" || echo "❌ GitHub 不可达"

**体检判读**：

- 第 1-3 项任何 ❌：先装对应工具（Debian: apt install docker.io docker-compose-plugin git，Docker 官方源更佳）
- 第 4 项可用空间 < 6GB：先做第五步清理，或清旧镜像
- 第 5 项 ❌：检查 DNS/防火墙（只需 443 出站）

**版本锚点说明**：

- **本次部署 = fde-v1.64.0.1 分支**（上游 merge v1.64.0 + MCP ping handler）
- 分支 fde-v1.64.0.1 = tag fde-v1.50.0.3（33f53658，现行稳定版）→ merge upstream v1.64.0（0376d768）→ feat ping handler
- tag fde-v1.50.0.3 = 上一个可用版本（v1.50.0.3 三 BUG 修复版，远端而家跑紧），**首选回滚锚点**
- tag fde-v1.50.0.2（2dfd30ac）= 次选回滚锚点
- v1.50.0.3 → v1.64.0.1 **有数据库 schema 变化**：上游带来 11 个新 migration（上游 0036_resource_multipart_uploads + 0037-0046 十个；multipart uploads / scheduled tasks / companion AI / inbox identity）。**首次启动自动应用，无需手动 migrate**；⚠️ migration 撞号（上游 0036_resource_multipart_uploads vs 我哋 0036_mcp_token_hidden）无害——runner 按完整档案名 tracking，两者都会被正确应用一次（我哋嗰条远端已应用过会 skip，上游嗰条会执行）

**本版变更内容（v1.64.0.1）**：

1. **上游 merge v1.64.0**：上游 v1.50.0 → v1.64.0 全部更新（263 commits：plugins 生态、diagram 图表、multipart 大附件上传、scheduled tasks、companion AI 预览、编辑器增强等）；MCP 工具 42 → 45（+create_diagram_memo / get_diagram / update_diagram）
2. **MCP `ping` handler**：EdgeEver 响应 MCP 规范嘅 ping method（空结果 + 200），MCP 客户端 keepalive 由拉全工具表变 ping 轻探针，消 reconnect 时嘅 404/-32601 噪音
3. **隔离功能全量保留**：per-token 隔离、NULL-safe 修正（BUG-002/002b）、search 修复（BUG-001）、tag verified 字段（BUG-003）全部喺 merge 后实测回归通过（全库 1829 pass / 8 pre-existing fail 与基线一致；泄露矩阵 15/0；BUG 探针全绿）


---

## 📦 第一步：获取源码

📌 **两种场景二选一**：远端已有一个旧版 edgeever 源码仓库（今次及以后大部分情况）→ 用 **场景 A**；全新机器 / 换目录 → 用 **场景 B**。

### 场景 A：既有仓库升级（默认 —— 远端已有 fde-v1.50.0.3 等旧版仓库）

喺既有源码目录（例如 /opt/edgeever-src）逐条执行：

    git fetch origin --tags
    git checkout fde-v1.64.0.1
    git pull origin fde-v1.64.0.1

核对（两条都应通过）：

    git log --oneline -1
    # 应显示：docs: DEPLOY_REMOTE_BUILD V2.4 for fde-v1.64.0.1
    git describe --tags --exact-match
    # 应输出：fde-v1.64.0.1

**排障**：如果 fetch 报 `! [rejected] ... (would clobber existing tag)` 或 pull 报
`Need to specify how to reconcile divergent branches` —— 只会喺「之前 fetch 过旧版同名 tag」
嘅仓库出现（例如 AI 部署通知前曾拉过一次）。恢复法（实测 2026-09-10）：

    git tag -d fde-v1.64.0.1
    git fetch origin --tags
    git checkout fde-v1.64.0.1
    git pull origin fde-v1.64.0.1
    git describe --tags --exact-match    # 应输出 fde-v1.64.0.1

⚠️ **HEAD detached 说明**：单分支 clone 入面 checkout 新分支名时，git 找不到同远端 tracking 分支但找到同名 tag，会落在「HEAD detached at fde-v1.64.0.1」—— **呢个係正常现象唔係错误**（实测 2026-09-10）：docker build 只需要源码文件树，detached 状态文件齐全、build 无影响。以后升级更新版本时同样三步（checkout 新版本号）即可。

⚠️ dirty tree 处理：checkout 前先检查

    git status --porcelain

应输出空（远端纯 build 目录正常永唔会有本地改动）。如有输出（意外改动），先 stash 保存唔好删：

    git stash push -m "pre-update-$(date +%s)"

### 场景 B：首次 Clone（全新机器 / 新目录先用）

1. 选个目录，例如 /opt/edgeever-src：

       git clone --branch fde-v1.64.0.1 --single-branch https://github.com/fde-lander/edgeever.git /opt/edgeever-src

2. 验证 HEAD commit：

       cd /opt/edgeever-src && git log --oneline -1

   应显示：docs: DEPLOY_REMOTE_BUILD V2.4 for fde-v1.64.0.1（可用 git describe --tags --exact-match 确认输出 fde-v1.64.0.1）

   注：`--single-branch` clone 默认已带全部 tags（git 默认 --tags 跟 clone 走），无需额外 fetch tag 即可 checkout 旧 tag 回滚。

3. ⚠️ **权限说明**：如果系 root 执行 clone，文件 owner 系 root，对纯 build 场景冇问题
   （build 喺容器内 COPY 处理，运行容器 USER bun 只读镜像内文件，唔读源码目录）。

---

## 🏗 第二步：远端 Build 镜像

在源码目录（/opt/edgeever-src）执行（版本号必须与本次部署目标一致 = **v1.64.0.1**）：

    docker build \
      --build-arg EDGE_EVER_BUILD_ID=$(git rev-parse HEAD) \
      -t edgeever-fde:v1.64.0.1 \
      .

要点：
- BUILD_ID 用 $(git rev-parse HEAD) 自动填当前 HEAD 全 hash —— /api/health 嘅 build 字段 = 拉到嘅源码 commit 前 12 位，**永远自洽**（唔使手抄 hash，唔会抄错）
- `-t` 标签名自定，与 .env 的 EDGE_EVER_IMAGE / EDGE_EVER_VERSION 对应即可
- 首次 build 要下载 oven/bun:1.3.14-alpine 基础镜像 + bun install 全部依赖，耗时较长（视网络 5-20 分钟）
- 磁盘需求：build 过程峰值约 4-6 GB，build 完可清理（见第五步）

验证镜像存在：

    docker images | grep edgeever

---

## 🔧 第三步：compose 指向本地 build 镜像

仓库自带的 compose.yaml 默认拉 ghcr.io 官方镜像，本地 build 要用 .env 覆盖。

在 compose 文件同目录建 .env（如果已有就改）：

    EDGE_EVER_IMAGE=edgeever-fde
    EDGE_EVER_VERSION=v1.64.0.1
    EDGE_EVER_PORT=8787
    EDGE_EVER_AUTH_USERNAME=admin
    EDGE_EVER_AUTH_PASSWORD=你的密码

注意 compose.yaml 用 "image: ${EDGE_EVER_IMAGE}:${EDGE_EVER_VERSION}"，
所以 EDGE_EVER_IMAGE=edgeever-fde + EDGE_EVER_VERSION=v1.64.0.1 会拼出 edgeever-fde:v1.64.0.1，
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

验证健康（应返回 "ok": true、"migration":"0046_..."、"build":"<本次 commit hash 前 12 位>"）：

    curl -s http://127.0.0.1:8787/api/health

⚠️ 首次启动 v1.64.0.1 时会自动应用 11 个新 migration，启动日志应有 11 行
`[self-hosted] applied migration ...`：由 `0036_resource_multipart_uploads.sql`
（上游 0036 与我哋 0036_mcp_token_hidden 同号唔同名——我哋嗰条远端已应用会 skip，
上游呢条係新档案会执行）一路到 `0046_restore_workspace_inbox_identity.sql`。

---

## 🔁 日常升级流程（以后每个新版本照此，本次 = v1.50.0.3 → v1.64.0.1）

1. 本地 AI 改完代码 push 到 GitHub 分支，并告知**新 commit hash**（每次升级都用通知嘅 hash 校验，唔好凭记忆拉）
2. 远端更新源码（同第一步场景 A 嘅三步命令）：

       cd /opt/edgeever-src
       git fetch origin --tags
       git checkout fde-v1.64.0.1
       git pull origin fde-v1.64.0.1
       git log --oneline -1     # 应显示 docs: DEPLOY_REMOTE_BUILD V2.4 ...，一致先继续

3. 重新 build（BUILD_ID 自动填当前 HEAD）：

       docker build --build-arg EDGE_EVER_BUILD_ID=$(git rev-parse HEAD) -t edgeever-fde:v1.64.0.1 .

4. 改 .env 版本号 → 重建容器：

       # .env 入面：EDGE_EVER_VERSION=v1.64.0.1
       docker compose up -d

5. 验证（健康端点 + 本次变更重点）：

       curl -s http://127.0.0.1:8787/api/health
       # 应返回 "ok": true、"migration":"0046_..."（本次有 schema 变化，首次启动后 0036→0046）+ "build":"<hash>…"

**本次升级（v1.50.0.3 → v1.64.0.1）验证重点**：

- MCP `ping` 应返回 200 空结果（新功能；Hermes gateway 观察角度见 Phase 18 验证计划）
- MCP 工具列表 42 → 45（+create_diagram_memo / get_diagram / update_diagram）
- 上游新功能可用（diagram 图表 / multipart 大附件，Web 端实测）
- 被隔离分类仍然完全不可见 —— 隔离功能未被上游 merge 削弱（全方向探针见 Phase 18）
- `search_memos`（BUG-001）/ `create_notebook`（BUG-002）/ `rename_tag` 返 `verified:true` + `remainingOldTag:0`（BUG-003）三条修复全部无回归
- 空分类仍然可见（BUG-002 修复仍然有效）

6. 旧镜像确认新版运行正常后可删：docker rmi edgeever-fde:v1.50.0.3

---

## 🧹 第五步：Build 残留清理（Bun + Docker 释放空间）

### 5.1 Docker build cache（大头，每次 build 都会累积）

查看占用：

    docker system df

清理 build cache（安全，下次 build 变慢但无副作用）：

    docker builder prune -f

只清悬空 cache 保留最近层：docker builder prune --keep-storage 2GB -f

### 5.2 悬空/旧镜像

    docker image prune -f          # 删 dangling
    docker rmi 旧tag               # 手动删旧版本镜像（确认新版正常先删）

### 5.3 源码目录 Bun 残留（远端直接 docker build 时不会产生！）

⚠️ 重点：第二步的 docker build 全部在容器内进行（多阶段 build），**远端源码目录不会生成 node_modules**，
除非你在远端直接跑过 bun install / bun run（不要这样做，无必要）。

检查命令：

    du -sh /opt/edgeever-src/node_modules 2>/dev/null || echo "干净，无 node_modules"

如果存在（曾手动跑过 bun install），清理：

    rm -rf /opt/edgeever-src/node_modules /opt/edgeever-src/apps/*/node_modules /opt/edgeever-src/packages/*/node_modules
    rm -rf /opt/edgeever-src/.bun-cache 2>/dev/null

### 5.4 Bun 全局缓存（只有远端装了 bun 才会有；纯 docker build 不需要装 bun！）

如果远端曾装过 bun CLI 且不再需要：

    du -sh ~/.bun   # 看占用（本机实测 ~2.1GB）
    rm -rf ~/.bun   # 完全移除（会删掉 bun 可执行文件）

或只清 install cache 保留 bun 本体：

    rm -rf ~/.bun/install/cache

⚠️ 参考数据（本机实测）：edgeever node_modules = 1.9GB，bun install cache = 2.0GB。
远端用 docker build 方法两者都应保持为 0。

### 5.5 一键体检脚本

    echo "=== Docker ==="
    docker system df
    echo "=== 源码目录残留 ==="
    du -sh /opt/edgeever-src/node_modules 2>/dev/null || echo "无 node_modules ✓"
    echo "=== Bun 残留 ==="
    du -sh ~/.bun 2>/dev/null || echo "无 ~/.bun ✓"
    echo "=== 磁盘 ==="
    df -h / | tail -1

---

## ⚠️ 回滚方案

1. **首选（镜像还在时）**：.env 改回旧版本号 EDGE_EVER_VERSION=v1.50.0.3 → docker compose up -d（秒回）
2. **镜像已删**（rebuild 旧版）：

       cd /opt/edgeever-src
       git checkout fde-v1.50.0.3    # single-branch clone 已带全部 tags，直接 checkout 得
       git log --oneline -1          # 应显示 33f53658
       docker build --build-arg EDGE_EVER_BUILD_ID=33f53658 -t edgeever-fde:v1.50.0.3 .
       # .env 改 EDGE_EVER_VERSION=v1.50.0.3 → docker compose up -d
       # 注意：checkout 旧 tag 后源码目录停喺 detached HEAD，回新版本时再 git checkout fde-v1.64.0.1

3. **次选更旧锚点**：tag `fde-v1.50.0.2`（2dfd30ac），同样手法（BUILD_ID=2dfd30ac，tag v1.50.0.2）
4. **回滚到任意更旧版本**：git checkout <该版本 tag 或 commit> → docker build -t edgeever-fde:<自定义tag> . → .env 对应改 → up -d
5. 数据安全：数据在 ./edgeever-data bind mount，镜像操作完全不影响

### ⚠️ 回滚特殊注意（v1.64.0.1 有 schema 变化，同以往唔同）

v1.64.0.1 首次启动会应用 11 个新 migration（上游 0036_resource_multipart_uploads + 0037-0046 十个；数据库结构升级，**升级方向自动、安全**）。
但**回滚到 v1.50.0.3 时数据库已经升级咗**，注意：

- **v1.50.0.3 服务器可以正常启动**：旧版代码唔识得 0037-0046 嗰啲新表，唔会报错、唔会删数据 —— 新表只係「多咗但用唔着」（已逐条核实：0037-0045 嘅 ALTER 全部落喺呢批新表自己身上，**无一条改动 0001-0036 旧表结构**）
- **⚠️ 唯一例外：0046 有一次性 UPDATE 现有 notebooks 表**（inbox 规范化：恢复被删嘅 nb_inbox + slug 锁定 'inbox'）。呢个係**单向数据规范化**，回滚唔会还原，但无破坏性 —— 如果主人从未删过/改过 inbox 分类，呢条 UPDATE 对数据零影响
- **⚠️ 如果之后又想再升级返 v1.64.0.1**：migration runner 睇 `_edgever_migrations` 表，0037-0046 已记录为已应用 → 唔会重跑 → 直接照常用，**无数据问题**
- **唯一要避免嘅操作**：回滚期间**唔好删除/重建 data volume**（`./edgeever-data`）—— 咁样会连笔记数据一齐删埋
- **结论**：回滚安全（数据全保），再升级亦安全（migration 状态持久），只要**永远唔删 data volume** 就得

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
