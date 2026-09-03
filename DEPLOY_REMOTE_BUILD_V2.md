# EdgeEver 远端 Git Clone + Build 部署教程（V2.3 — 远端 git clone + docker build）

> 📅 2026-09-04 | 本次部署目标：**分支 fde-v1.50.0.3（BUG-002 / BUG-002b / BUG-003 修复版）**
> 回滚锚点：**tag fde-v1.50.0.2（2dfd30ac）** 首选 / **tag fde-v1.50.0.1（5ab893a6）** 次选 | 适用本次及未来所有版本

> 🔄 **交付方式定案（2026-09-04，以后一律照此）**：本地 build → `docker save` → tar.zst → scp 传输**永久废弃**。
> 唯一流程：**远端 git pull → 远端 docker build → 本地镜像 → compose 使用**。实测 clone 体积约 35MB。
> AI 交付物只有两样：**commit hash + 面向用户嘅变更说明**，唔再交任何镜像文件。
> （旧 tar 文件 edgeever-fde-v1.50.0.1.tar.zst 同旧教程 DEPLOY_V1.50.0.1.md 已于 2026-09-04 删除。）

> **版本变更记录**
>
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

- **本次部署 = fde-v1.50.0.3 分支**（BUG-002 / BUG-002b / BUG-003 修复）
- 分支 fde-v1.50.0.3 基点 = tag fde-v1.50.0.2（2dfd30ac），其上叠加 3 个 commits（fix / test / docs）
- tag fde-v1.50.0.2 = 上一个可用版本（BUG-001 已修，但空分类喺 MCP 隐形、AI 新建分类 100% 报 404），**首选回滚锚点**
- tag fde-v1.50.0.1（5ab893a6）= 更早嘅可用版本，次选回滚锚点
- v1.50.0.2 → v1.50.0.3 **无数据库 schema 变化**（migration 仍然 0036，唔使 migrate；diff 只改 mcp-hiding.ts / tag-service.ts / mcp-tool-service.ts / tag-routes.ts / packages/client + 测试 + 文档）

**本版修复内容（v1.50.0.3）**：

1. **BUG-002**：AI（agent token）新建分类 100% 报 `Notebook not found after create` → 已修；空分类喺 MCP / REST 完全隐形 → 已修
2. **BUG-002b**：无 memo_contents 行嘅笔记会被误过滤 → 已修（同一类 NULL 三值逻辑问题，涉 6 张关联表）
3. **BUG-003**：`rename_tag` / `delete_tag` 响应新增 `verified` + `remainingOldTag`，静默写入失败变可见（详见文末专章）
4. **隔离功能唔变**：被隔离分类同其内容仍然完全不可见（含空嘅被隔离分类）


---

## 📦 第一步：Clone 源码（首次）

1. 选个目录，例如 /opt/edgeever-src：

       git clone --branch fde-v1.50.0.3 --single-branch https://github.com/fde-lander/edgeever.git /opt/edgeever-src

2. 验证 HEAD commit（**以每次部署通知嘅 commit hash 为准**）：

       cd /opt/edgeever-src && git log --oneline -1

   本次预期输出 = 部署通知里嘅 docs commit（fde-v1.50.0.3 分支 HEAD，`docs: DEPLOY_REMOTE_BUILD V2.3 ...`）。

   注：`--single-branch` clone 默认已带全部 tags（git 默认 --tags 跟 clone 走），无需额外 fetch tag 即可 checkout 旧 tag 回滚。

3. ⚠️ **权限说明**：如果系 root 执行 clone，文件 owner 系 root，对纯 build 场景冇问题
   （build 喺容器内 COPY 处理，运行容器 USER bun 只读镜像内文件，唔读源码目录）。

---

## 🏗 第二步：远端 Build 镜像

在源码目录（/opt/edgeever-src）执行（版本号必须与本次部署目标一致 = **v1.50.0.3**）：

    docker build \
      --build-arg EDGE_EVER_BUILD_ID=<部署通知嘅commit hash> \
      -t edgeever-fde:v1.50.0.3 \
      .

要点：
- `-t` 标签名自定，与 .env 的 EDGE_EVER_IMAGE / EDGE_EVER_VERSION 对应即可
- `--build-arg EDGE_EVER_BUILD_ID` 会显示喺 /api/health 返回嘅 build 字段，方便审计（填本次 commit hash）
- 首次 build 要下载 oven/bun:1.3.14-alpine 基础镜像 + bun install 全部依赖，耗时较长（视网络 5-20 分钟）
- 磁盘需求：build 过程峰值约 4-6 GB，build 完可清理（见第五步）

验证镜像存在：

    docker images | grep edgeever

---

## 🔧 第三步：compose 指向本地 build 镜像

仓库自带的 compose.yaml 默认拉 ghcr.io 官方镜像，本地 build 要用 .env 覆盖。

在 compose 文件同目录建 .env（如果已有就改）：

    EDGE_EVER_IMAGE=edgeever-fde
    EDGE_EVER_VERSION=v1.50.0.3
    EDGE_EVER_PORT=8787
    EDGE_EVER_AUTH_USERNAME=admin
    EDGE_EVER_AUTH_PASSWORD=你的密码

注意 compose.yaml 用 "image: ${EDGE_EVER_IMAGE}:${EDGE_EVER_VERSION}"，
所以 EDGE_EVER_IMAGE=edgeever-fde + EDGE_EVER_VERSION=v1.50.0.3 会拼出 edgeever-fde:v1.50.0.3，
正好对应第二步的 -t 标签。

⚠️ 如果你用独立目录管理 compose（如 /opt/edgeever），唔使用源码目录的 compose.yaml，
可以复制一份过去：cp /opt/edgeever-src/compose.yaml /opt/edgeever/
数据卷 edgeever-data 独立于源码目录，升级重 build 唔影响数据。

启动/更新（.env 改好版本号后 up -d 会自动重建容器）：

    docker compose up -d

验证健康（应返回 "ok": true、"migration":"0036_..."、"build":"<本次 commit hash 前 12 位>"）：

    curl -s http://127.0.0.1:8787/api/health

---

## 🔁 日常升级流程（v1.50.0.2 → v1.50.0.3 为例）

1. 本地 AI 改完代码 push 到 GitHub 分支，并告知**新 commit hash**（每次升级都用通知嘅 hash 校验，唔好凭记忆拉）
2. 远端拉取（含 dirty tree 处理）：

       cd /opt/edgeever-src
       git status --porcelain   # 应为空输出；远端纯 build 目录正常永唔会有本地改动
       # 如有输出（意外改动），先 stash 保存唔好删：
       #   git stash push -m "pre-pull-$(date +%s)"
       git fetch origin --tags
       git checkout fde-v1.50.0.3
       git pull origin fde-v1.50.0.3
       git log --oneline -1     # 核对 = 通知嘅 commit hash，一致先继续

3. 重新 build（用新 commit hash 做 BUILD_ID）：

       docker build --build-arg EDGE_EVER_BUILD_ID=<通知嘅commit hash> -t edgeever-fde:v1.50.0.3 .

4. 改 .env 版本号 → 重建容器：

       # .env 入面：EDGE_EVER_VERSION=v1.50.0.3
       docker compose up -d

5. 验证（健康端点 + 本次修复重点）：

       curl -s http://127.0.0.1:8787/api/health
       # 应返回 "ok": true、"migration":"0036_..."（本次无 schema 变化，仍然 0036）+ "build":"<hash>…"

**本次升级（v1.50.0.2 → v1.50.0.3）验证重点**：

- MCP `create_notebook` 应成功返回（BUG-002 已修，唔再报 `Notebook not found after create`）
- MCP `list_notebooks` 应见到**空分类**（之前空分类完全隐形）
- 被隔离分类仍然完全不可见（含空嘅被隔离分类）—— 隔离功能未被削弱
- `search_memos` 无回归（BUG-001 修复仍然有效）
- `rename_tag` 响应含 `verified: true` + `remainingOldTag: 0`

6. 旧镜像确认新版运行正常后可删：docker rmi edgeever-fde:v1.50.0.2

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

1. **首选（镜像还在时）**：.env 改回旧版本号 EDGE_EVER_VERSION=v1.50.0.2 → docker compose up -d（秒回，**无 schema 变化**）
2. **镜像已删**（rebuild 旧版）：

       cd /opt/edgeever-src
       git checkout fde-v1.50.0.2    # single-branch clone 已带全部 tags，直接 checkout 得
       git log --oneline -1          # 应显示 2dfd30ac
       docker build --build-arg EDGE_EVER_BUILD_ID=2dfd30ac -t edgeever-fde:v1.50.0.2 .
       # .env 改 EDGE_EVER_VERSION=v1.50.0.2 → docker compose up -d
       # 注意：checkout 旧 tag 后源码目录停喺 detached HEAD，回新版本时再 git checkout fde-v1.50.0.3

3. **次选更旧锚点**：tag `fde-v1.50.0.1`（5ab893a6），同样手法（BUILD_ID=5ab893a6，tag v1.50.0.1）
4. **回滚到任意更旧版本**：git checkout <该版本 tag 或 commit> → docker build -t edgeever-fde:<自定义tag> . → .env 对应改 → up -d
5. 数据安全：数据在 ./edgeever-data bind mount，镜像操作完全不影响
6. 回滚后旧 bug 会重现，属预期现象：
   - 回滚到 v1.50.0.2 → AI 新建分类再次 100% 报 404、空分类再次隐形、tag 响应无 `verified` 字段
   - 回滚到 v1.50.0.1 → 上述问题 + search_memos 再报 ambiguous column name（BUG-001）

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
