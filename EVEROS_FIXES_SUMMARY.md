# EverOS Integration — Bug 修复与架构知识总结

> 日期：2026-06-20  
> 版本：v1.1.0 → fix  
> 修复人：Claude Code + czqwq

---

## 一、EverOS 记忆系统架构概览

### 1.1 三层存储

```
Markdown（真理源）  +  SQLite（状态）  +  LanceDB（向量 + BM25 + 标量索引）
```

- **Markdown**：`~/.everos/<app>/<project>/users/<owner_id>/episodes/episode-YYYY-MM-DD.md`
  - 每天一个文件，每条记忆以 `<!-- entry:ep_YYYYMMDD_NNNN -->` 标记包裹
  - 记忆条目使用 **审计表单格式**：`## 标题` → `**key**: value` → `### 分段标题`
- **SQLite**：`~/.everos/.index/sqlite/system.db` — 存储 `md_change_state` 追踪每个 markdown 文件的变更
- **LanceDB**：`~/.everos/.index/lancedb/` — 可重建的向量/BM25 索引，Dashboard 实际从这里查询

### 1.2 记忆写入流程（`POST /api/v1/memory/add`）

```
messages[] → ingest → boundary_detection → cells
    ├→ UserMemoryPipeline
    │   ├→ extract_atomic_facts → markdown writer → 每日.md
    │   ├→ extract_foresight
    │   └→ extract_user_profile
    └→ AgentMemoryPipeline (mode=agent)
        ├→ extract_agent_case
        └→ extract_agent_skill
```

关键点：
1. 消息以 `session_id` 为 key 累积在缓冲区
2. 边界检测（50条/8192 token）触发后，将缓冲区切分成 `cell`
3. 每个 cell 经过 LLM 提取，生成结构化记忆写入 markdown
4. **Cascade 守护进程**监控 markdown 文件变化，同步到 LanceDB

### 1.3 记忆读取流程（`POST /api/v1/memory/get`）

```
GetRequest {memory_type, user_id XOR agent_id, ...}
    → GetManager.get()
    → LanceDB find_where_paginated(WHERE owner_id=X, ...)
    → GetResponse {data: {episodes: [...], total_count: N}}
```

**硬约束**：`user_id` 和 `agent_id` 互斥，必须且只能提供一个。  
- `episode` / `profile` → `user_id`（user track）  
- `agent_case` / `agent_skill` → `agent_id`（agent track）

这意味着**无法一次查询所有记录**——必须按 owner_id 分别查询。

### 1.4 记忆 ID 格式

- Markdown entry ID：`ep_YYYYMMDD_NNNN`（如 `ep_20250620_00000001`）
- LanceDB PK：`<owner_id>_<entry_id>`（如 `default_ep_20250620_00000001`）
- 全局唯一性由 owner_id + entry_id 组合保证

---

## 二、Dashboard 显示流程

### 2.1 组件架构

```
前端 (index.html + app.js)
    ↓ GET /api/everos/memories
独立服务器 (standalone_server.py :18766)  或  AstrBot 内嵌 (main.py)
    ↓ POST /api/v1/memory/get (每 type × uid 组合)
EverOS REST API (:8765)
    ↓ LanceDB 查询
LanceDB 索引
```

### 2.2 前端查询策略（app.js）

1. `loadOverview()` → `GET /api/everos/status` → 显示健康状态 + 统计
2. `loadMemories(type)` → `GET /api/everos/memories` 或 `POST /api/everos/memories-by-type`
3. `doSearch()` → `POST /api/everos/search` → 语义检索

### 2.3 后端查询策略

```python
# candidate_uids 决定查询哪些 owner
candidate_uids = ["astrbot", "default", "webui", "assistant", ...tracked_ids, ...extra_user_ids]

for mtype in ("episode", "profile", "agent_case", "agent_skill"):
    for uid in candidate_uids:
        items = fetch(mtype, uid)  # 调用 EverOS /get
```

---

## 三、发现的 Bug 及修复

### 🐛 Bug #1（关键）：Dashboard 只读取前 20 条记录

**严重程度**：🔴 高  
**影响范围**：所有 Dashboard 页面（总览统计、记忆仓库、技能库）

**根因**：
EverOS `/api/v1/memory/get` 默认 `page_size=20`。Dashboard 后端只调用一次，未翻页。
如果某 `(type, owner_id)` 组合有 100 条记录，第 21-100 条**完全不可见**。

**受影响的文件**：
- `main.py`：`api_status()`, `api_memories()`, `api_memories_by_type()`
- `core/standalone_server.py`：`api_status()`, `api_memories()`, `api_memories_by_type()`

**修复方案**：
1. 在 `EverOSClient` 中新增 `memory_get_all()` 方法，自动翻页直到 `total_count` 耗尽
2. 在 `StandaloneServer` 中新增 `_fetch_all_memories_for()` 辅助方法
3. 所有获取记忆的后端 API 统一改用翻页版本

**关键代码**（`core/everos_client.py`）：
```python
async def memory_get_all(self, memory_type, user_id, agent_id, ...):
    """分页获取全部条目，自动翻页直到 total_count 耗尽。"""
    all_items = []
    page = 1
    while page <= 50:  # 安全上限
        result = await self.memory_get(..., page=page, page_size=100)
        items = data.get(f"{memory_type}s", [])
        if not items:
            break
        all_items.extend(items)
        if len(items) < page_size or page * page_size >= total_count:
            break
        page += 1
    return all_items
```

---

### 🐛 Bug #2（关键）：Dashboard 不知道真实用户的 QQ ID

**严重程度**：🔴 高  
**影响范围**：聊天记录存储到特定 QQ 号后，Dashboard 无法显示

**根因**：
1. `_track_user()` 只在 `/everos` **命令处理器**中调用，不在普通消息中调用
2. `_known_user_ids` 仅存内存中，插件重启即丢失
3. `candidate_uids` 是固定列表 `["astrbot", "default", "webui"]`

**场景复现**：
- 用户 QQ `1638501774` 发送消息
- LLM 调用 `everos_memorize(content="...", user_id="1638501774")`
- 记忆存入 EverOS，`owner_id = "1638501774"`
- Dashboard 查询 `candidate_uids = ["astrbot", "default", "webui"]` — 不包含 `"1638501774"`
- ❌ 记录完全不可见

**修复方案**：
1. **持久化 `_known_user_ids`** 到 `everos_known_users.json`，插件重启不丢失
2. **LLM 工具自动追踪**：`everos_memorize`、`everos_learn`、`everos_recall` 调用时记录 user_id
3. **新增配置项 `extra_user_ids`**：用户可在插件配置中手动指定额外 ID（逗号分隔）
4. `candidate_uids` 扩展为：固定基础 + 持久化追踪 + 手动配置

**关键代码**（`tools/everos_tools.py`）：
```python
def _track_user_to_file(user_id: str) -> None:
    """将 user_id 持久化到已知用户文件，确保跨插件重启不丢失。"""
    if not user_id or user_id in ("default", "webui"):
        return
    # 读取现有列表 → 追加 → 写回 JSON
```

---

### 🐛 Bug #3（中等）：agent_case 在 Dashboard 显示为原始 JSON

**严重程度**：🟡 中  
**影响范围**：Dashboard 记忆仓库中 agent_case 类型的卡片内容

**根因**：
`_normalize_item()` 函数未处理 `agent_case` 和 `agent_skill` 类型，走 else 分支直接 `json.dumps(item)`。

**修复方案**：
```python
elif mtype == "agent_case":
    item["content"] = (
        item.get("task_intent", "")
        or item.get("key_insight", "")
        or item.get("approach", "")
    )
elif mtype == "agent_skill":
    item["content"] = (
        item.get("description", "")
        or item.get("name", "")
    )
```

---

### 🐛 Bug #4（低）：candidate_uids 缺少 "assistant"

**严重程度**：🟢 低  
**影响范围**：agent track 记忆（Case/Skill）的可见性

**根因**：
`EverOSLearnTool` 使用 `sender_id = "assistant"`，生成的 agent_case/agent_skill 的 `owner_id` 可能为 `"assistant"`。但 candidate_uids 不包含 `"assistant"`。

**修复方案**：
`candidate_uids` 基础列表添加 `"assistant"`。

---

## 四、关于记录 `1638501774` 的专项分析

`1638501774` 是一个 10 位数字，符合 QQ 号的特征。

### 为什么 Dashboard 无法读取这条记录？

可能原因（按可能性排序）：

| 可能性 | 原因 | 修复后是否解决 |
|--------|------|----------------|
| ⭐⭐⭐ | 该记录的 `owner_id` 是 `"1638501774"`（QQ号），不在旧的 `candidate_uids` 中 | ✅ 是（Bug #2 修复） |
| ⭐⭐ | 该记录位于某 user 的第 21+ 条，被 pagination 截断 | ✅ 是（Bug #1 修复） |
| ⭐ | 记录存在但 `app_id`/`project_id` 不匹配 | ⚠️ 需确认配置一致性 |

### 验证方法

1. 确认 `extra_user_ids` 配置中包含 `1638501774`
2. 访问 Dashboard → 记忆仓库，应能看到所有记录
3. 或直接调用 API：
```bash
curl -X POST http://127.0.0.1:8765/api/v1/memory/get \
  -H "Content-Type: application/json" \
  -d '{"memory_type":"episode","user_id":"1638501774","page_size":100}'
```

---

## 五、修改文件清单

| 文件 | 变更 |
|------|------|
| `core/everos_client.py` | 新增 `memory_get()` 的 `page`/`page_size` 参数；新增 `memory_get_all()` 全量翻页方法 |
| `core/standalone_server.py` | 新增 `_fetch_all_memories_for()` 辅助；`api_status`/`api_memories`/`api_memories_by_type` 改用全量翻页；扩展 `_get_candidate_uids` |
| `main.py` | `api_status`/`api_memories`/`api_memories_by_type` 改用 `memory_get_all()`；扩展 `_get_candidate_uids`；新增 `_load_known_users`/`_save_known_users` 持久化；修复 `_normalize_item` |
| `core/config_manager.py` | 新增 `extra_user_ids` 配置项及属性 |
| `tools/everos_tools.py` | 新增 `_track_user_to_file()` 持久化追踪；所有工具调用时自动记录 user_id |

---

## 六、EverOS 核心架构知识点

### 6.1 关键路径

```
记忆写入：
  client → POST /add → ingest → boundary → extract → markdown → cascade → LanceDB

记忆读取：
  client → POST /get → GetManager → LanceDB query → DTO → response

Dashboard 查询：
  browser → GET standalone:18766/api/everos/memories → 遍历 candidate_uids → EverOS /get
```

### 6.2 关键约束

1. **owner 互斥**：`/get` 必须且只能提供 `user_id` 或 `agent_id` 之一
2. **app/project 隔离**：所有查询都按 `(app_id, project_id)` 过滤
3. **Cascade 异步同步**：markdown → LanceDB 有延迟（最多 30s 扫描周期）
4. **默认分页**：EverOS `/get` 默认 `page_size=20`，上限 100

### 6.3 ID 体系

| 层级 | 格式 | 示例 |
|------|------|------|
| Markdown entry ID | `<PREFIX>_YYYYMMDD_NNNN` | `ep_20250620_00000001` |
| LanceDB PK | `<owner_id>_<entry_id>` | `default_ep_20250620_00000001` |
| session_id | 调用方传入 | `webui-default-1718841600000` |
| owner_id | 来自消息 sender_id | `1638501774` (QQ号) |

### 6.4 数据流中的 owner_id 传递

```
AstrBot message sender_id
    → EverOSMemorizeTool.resolved_user_id (= user_id or persona_name or "default")
    → memorized message.sender_id
    → ingest → memcell
    → extracted episode.owner_id
    → markdown frontmatter.user_id
    → cascade handler
    → LanceDB Episode.owner_id
```

---

## 七、后续建议

1. **EverOS 服务端增强**：考虑添加 `GET /api/v1/memory/owners` 端点，返回所有存在的 owner_id 列表（通过扫描 markdown 目录），让 Dashboard 能自主发现所有用户
2. **Dashboard 实时性**：当前需手动刷新；可接入 WebSocket 或 SSE 推送 Cascade 同步事件
3. **owner 发现机制**：如果 EverOS 和 AstrBot 在同一台机器，可直接扫描 `~/.everos/` 目录获取 owner 列表
4. **监控 Cascade 延迟**：添加指标记录 markdown 写入到 LanceDB 可查询的端到端延迟
