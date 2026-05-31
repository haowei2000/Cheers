# Message 模型与分页（API + Resource 统一契约）

> **Status**: v1 已落地（兼容实现）  
> **Updated**: 2026-05-31  
> **Owner**: Rust Gateway (`server/src/domain/messages.rs`)

本文统一说明：

- `message` 这类对象在 REST 与 resource 里的含义
- 同一条消息列表函数如何服务两个入口
- `before` / `after` 分页语义和返回元信息

---

## 1. Message 的职责边界（当前实现）

- 消息落库于 `messages` 表，最终广播给浏览器前后端都要使用同一套 DTO。
- 业务域返回 `MessageDto`，字段至少包括：
  - `msg_id`, `channel_id`, `sender_type`, `sender_id`, `sender_name`
  - `content`, `content_data`（当前写入时主要使用 `content`）
  - `msg_type`, `is_partial`
  - `file_ids`, `files`
  - `mentions`, `reply_to_msg_id`, `created_at`
- 文件引用在消息层有两个阶段：
  - 入库时：仅保存 `file_ids`（防止超大 payload 与文件元数据绑定在同一事务之外）
  - 查询时：按 `file_ids` 批量补齐 `files` 字段，补齐 `preview_url` / `download_url`

---

## 2. 为何有两层入口，为什么共享一个列表函数

- REST 出口：`GET /api/v1/channels/{channel_id}/messages`
- Bot Resource 出口：`channel.messages`
- 两条路径都应返回同一套排序和分页行为，避免前端和 bot 分支出现时间顺序或游标错位。
- 实现上做了层次分离：
  - `domain::messages::list_messages(...)`  
    负责鉴权（`channel_memberships`）和参数合法性校验
  - `domain::messages::list_channel_messages(...)`  
    做真正 SQL 查询与装配（用户/mentions/file 附加），供 REST 与 resource 共用

`list_channel_messages` 正好是你要的“通用分页函数”。

---

## 3. 统一参数和兼容字段

### REST 查询参数

- `before`  
- `before_id`（兼容）
- `around_id`（兼容）
- `after`
- `after_id`（兼容）
- `limit`（默认 50，服务端截断为 1..200）

### Resource 参数（`channel.messages`）

- `before`, `before_id`, `around_id`
- `after`, `after_id`
- `limit`（默认 50，截断上限 200）
- `include_deleted`（当前查询仍保留并硬编码 `FALSE`）

说明：  
- `before` 与 `after` **不能同时出现**，两端会返回参数错误。
- `before` 与 `around_id` 当前行为一致，都是向“当前/历史更早方向”取窗口。

---

## 4. 分页模型（核心）

### 4.1 排序键

所有窗口查询按双键排序：

- 第一键：`created_at`
- 第二键：`msg_id`

查询阶段使用：

- `ORDER BY created_at DESC, msg_id DESC`

返回阶段反转一次：

- `msgs.reverse()`

因此对外始终保证**时间升序**返回（越早越前），便于前端直接渲染滚动列表。

### 4.2 窗口行为

1. `before = X`（或兼容字段）  
   取严格在 `X` 之前的消息（`created_at <`，或同时间 `msg_id <`）。  
   这是你现在历史分页的主路径。

2. `after = X`（或兼容字段）  
   取严格在 `X` 之后的消息（`created_at >`，或同时间 `msg_id >`）。  
   用于增量拉新（后续流式新增或补偿拉取）。

3. 无游标  
   返回最近一页（`created_at` 最新一侧），供首次加载。

### 4.3 `LIMIT + 1` 判定更多

每次查询 `limit + 1` 行，若取到更多则：

- `has_more = true`
- 响应中的 `messages` 截断为 `limit`

这样不依赖 `COUNT(*)`，查询更轻。

---

## 5. 响应元数据（REST 与 Resource 一致）

两端统一返回：

- `has_more_before`: 是否还有更早消息可继续向前拉取
- `has_more_after`: 是否还有更新消息可向后增量拉取
- `has_more`: `has_more_before || has_more_after`（便于旧判断）
- `anchor_found`: 游标消息是否存在
- `limit`: 当前生效 limit

REST 当前返回同时包含：

- `messages`: 历史兼容字段
- `data`: 新主字段

Resource 当前返回：

- `messages` + `data` + 同上 `meta`

---

## 6. 已知边界（本轮实现决定）

- `after` 分页已实现，但不做全量向前/向后混合聚合；一次调用只接受一个方向。
- `after` 指向不存在的消息时会返回空页（`anchor_found=false`）。
- 软/硬文件引用未在本说明展开：该文档仅约束列表语义与分页元数据，不涉及上传下载流程（参见 `FILE_STORAGE.md`、resource 文件路径）。

