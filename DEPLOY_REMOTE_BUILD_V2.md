# EdgeEver 远端 Git Clone + Build 部署教程（V2.1 — 远端 git clone + docker build）

> 📅 2026-09-02 | 分支 fde-v1.50.0.2（BUG-001 修复版）| 适用本次及未来所有版本
>
> 🔄 **方案变更说明**：旧方法（本地 build → docker save → tar.zst 169MB → scp）传输太慢已废弃。
> 新方法：远程服务器直接 git clone 源码 → 远端 docker build。源码 clone 只有几十 MB，快好多。
> 本地镜像 tar 文件方式（edgeever-fde-v1.50.0.1.tar.zst）唔再使用，可以删除。

> **版本变更记录**
>
> - **V2.1（2026-09-02）**：新增「第零步：前置环境体检」（Docker/git/磁盘硬性要求 + 一键体检脚本）；升级流程加入 **dirty tree 处理** 与指定 commit hash 校验；分支默认改为 **fde-v1.50.0.2**（BUG-001 修复）；TAG 基线 fde-v1.50.0.1 说明。
> - **V2.0（2026-09-02）**：取代预 BUILD tar.zst 传输 → 远端 git clone + docker build（clone → build → compose .env → 升级 → 清理 → 回滚）。

## 🎯 前提条件

- 远端服务器已装 Docker + docker compose plugin
- 能访问 GitHub（github.com/fde-lander/edgeever 是公开 fork）
- 已有 .env（EDGE_EVER_AUTH_PASSWORD 等）

---

## 🔍 第零步：前置环境体检（V2.1 新增，首次部署前必做）

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
- 第 4 项可用空间 < 6GB：先做第四步清理，或清旧镜像
- 第 5 项 ❌：检查 DNS/防火墙（只需 443 出站）

**TAG 基线说明**：v1.50.0.1（首个远端 build 版本，MCP 隔离功能完整但 search_memos 有 BUG-001）已打 tag 推送 GitHub，可作回滚锚点。**今次部署目标 = fde-v1.50.0.2 分支（BUG-001 修复版）**。

---

## 📦 第一步：Clone 源码（首次）

1. 选个目录，例如 /opt/edgeever-src：

   git clone --branch fde-v1.50.0.2 --single-branch https://github.com/fde-lander/edgeever.git /opt/edgeever-src

2. 验证 HEAD commit：

   cd /opt/edgeever-src && git log --oneline -1

   预期输出：fde-v1.50.0.2 分支最新 commit（**以每次部署通知嘅 commit hash 为准**）。
   fde-v1.50.0.2 基点 = 5ab893a6（v1.50.0.1 tag），其上叠加 BUG-001 修复 commits。

3. ⚠️ **权限检查（上次 EACCES 事故教训）**：
   如果系 root 执行 clone，文件 owner 系 root，Docker build 冇问题（build 容器内 COPY 后由 build 阶段处理）。
   但如果容器以 bun 用户读挂载目录才需要留意。纯 build 场景唔使改权限。

---

## 🏗 第二步：远端 Build 镜像

在源码目录（/opt/edgeever-src）执行：

   docker build \
     --build-arg EDGE_EVER_BUILD_ID=fde-v1.50.0.1 \
     -t edgeever-fde:v1.50.0.1 \
     .

要点：
- -t 标签名自定，与 .env 的 EDGE_EVER_IMAGE 对应即可
- --build-arg EDGE_EVER_BUILD_ID 会显示在 build 信息里，方便审计
- 首次 build 要下载 oven/bun:1.3.14-alpine 基础镜像 + bun install 全部依赖，耗时较长（视网络 5-20 分钟）
- 磁盘需求：build 过程峰值约 4-6 GB（node_modules + build cache），build 完可清理（见第五步）

验证镜像存在：

   docker images | grep edgeever

---

## 🔧 第三步：compose 指向本地 build 镜像

仓库自带的 compose.yaml 默认拉 ghcr.io 官方镜像，本地 build 要用 env 覆盖。

在 compose 文件同目录建 .env（如果已有就改）：

   EDGE_EVER_IMAGE=edgeever-fde
   EDGE_EVER_VERSION=v1.50.0.1
   EDGE_EVER_PORT=8787
   EDGE_EVER_AUTH_USERNAME=admin
   EDGE_EVER_AUTH_PASSWORD=你的密码

注意 compose.yaml 用 "image: ${EDGE_EVER_IMAGE}:${EDGE_EVER_VERSION}"，
所以 EDGE_EVER_IMAGE=edgeever-fde + EDGE_EVER_VERSION=v1.50.0.1 会拼出 edgeever-fde:v1.50.0.1，
正好对应第二步的 -t 标签。

⚠️ 如果你用独立目录管理 compose（如 /opt/edgeever），唔使用源码目录的 compose.yaml，
可以复制一份过去：cp /opt/edgeever-src/compose.yaml /opt/edgeever/
数据卷 edgeever-data 独立于源码目录，升级重 build 唔影响数据。

启动/更新：

   docker compose up -d

确认迁移（应看到 0036）：

   docker compose logs edgeever | grep migration

验证健康：

   curl -s http://127.0.0.1:8787/api/health

---

## 🔁 日常升级流程（BUG-001 修复部署为例）

1. 本地 AI 改完代码 push 到 GitHub 分支，并告知**新 commit hash**（每次升级都用通知嘅 hash 校验，唔好凭记忆拉）
2. 远端拉取（含 dirty tree 处理）：

   cd /opt/edgeever-src
   git status --porcelain   # 应为空输出；远端纯 build 目录正常永唔会有本地改动
   # 如有输出（意外改动），先 stash 保存唔好删：
   #   git stash push -m "pre-pull-$(date +%s)"
   git fetch origin
   git checkout fde-v1.50.0.2
   git pull origin fde-v1.50.0.2
   git log --oneline -1     # 核对 = 通知嘅 commit hash，一致先继续

3. 重新 build（新 tag 或同名覆盖）：

   docker build --build-arg EDGE_EVER_BUILD_ID=<通知嘅commit hash> -t edgeever-fde:v1.50.0.2 .

4. 改 .env 版本号 → docker compose up -d

   EDGE_EVER_IMAGE=edgeever-fde
   EDGE_EVER_VERSION=v1.50.0.2

5. 验证（迁移 + search 修复）：

   docker compose logs edgeever | grep migration     # 应看到 0036（首次）
   curl -s http://127.0.0.1:8787/api/health

6. 旧镜像可删：docker rmi edgeever-fde:v1.50.0.1

**本次升级（v1.50.0.1 → v1.50.0.2）验证重点**：

- MCP search_memos 任意 query 应正常返回（BUG-001 已修，唔再报 ambiguous column name: memo_id）
- search 命中应排除隐藏分类笔记（隔离语义）
- list_memos includeDescendants=1 正常（D3）
- 移动笔记防环检查正常（D4）

---

## 🧹 第四步：Build 残留清理（Bun + Docker 释放空间）

### 4.1 Docker build cache（大头，每次 build 都会累积）

查看占用：

   docker system df

清理 build cache（安全，下次 build 变慢但无副作用）：

   docker builder prune -f

只清悬空 cache 保留最近层：docker builder prune --keep-storage 2GB -f

### 4.2 悬空/旧镜像

   docker image prune -f          # 删 dangling
   docker rmi 旧tag               # 手动删旧版本镜像

### 4.3 源码目录 Bun 残留（远端直接 docker build 时不会产生！）

⚠️ 重点：第二步的 docker build 全部在容器内进行（多阶段 build），**远端源码目录不会生成 node_modules**，
除非你在远端直接跑过 bun install / bun run（不要这样做，无必要）。

检查命令：

   du -sh /opt/edgeever-src/node_modules 2>/dev/null || echo "干净，无 node_modules"

如果存在（曾手动跑过 bun install），清理：

   rm -rf /opt/edgeever-src/node_modules /opt/edgeever-src/apps/*/node_modules /opt/edgeever-src/packages/*/node_modules
   rm -rf /opt/edgeever-src/.bun-cache 2>/dev/null

### 4.4 Bun 全局缓存（只有远端装了 bun 才会有；纯 docker build 不需要装 bun！）

如果远端曾装过 bun CLI 且不再需要：

   du -sh ~/.bun   # 看占用（本机实测 ~2.1GB）
   rm -rf ~/.bun   # 完全移除（会删掉 bun 可执行文件）

或只清 install cache 保留 bun 本体：

   rm -rf ~/.bun/install/cache

⚠️ 参考数据（本机实测）：edgeever node_modules = 1.9GB，bun install cache = 2.0GB。
远端用 docker build 方法两者都应保持为 0。

### 4.5 一键体检脚本

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

1. .env 改回旧版本号（如 EDGE_EVER_VERSION=v1.50.0.1，镜像还在时）→ docker compose up -d（秒回）
2. 镜像已删：按升级流程 rebuild 旧 tag（git checkout fde-v1.50.0.1 或 tag fde-v1.50.0.1 → docker build -t edgeever-fde:v1.50.0.1 .）
3. 数据安全：数据在 edgeever-data volume，镜像操作完全不影响
4. 回滚后 search_memos 会再次报 BUG-001 错误（v1.50.0.1 旧 bug），属预期现象

---

## 📋 新旧方法对比

| 项目 | 旧（预 BUILD） | 新（远端 build） |
|------|---------------|----------------|
| 传输体积 | 169MB tar.zst | 几十 MB git 对象（增量更快） |
| 传输方式 | scp 文件 | git pull |
| 本地负担 | 本地 build+save+删 image | 零 |
| 远端负担 | docker load | docker build（耗 CPU 5-20min） |
| 回滚 | 保留多个 tar | git checkout + rebuild |
| 磁盘风险 | tar 累积 | build cache 累积（可 prune） |
