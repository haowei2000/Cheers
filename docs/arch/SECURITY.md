# AgentNexus 安全架构

> 版本：v1
> 分支：`break/rust-gateway-arch`
> 配套：[BOT_PERMISSION](./BOT_PERMISSION.md) · [ACP_INTEGRATION](./ACP_INTEGRATION.md)

本文定义 AgentNexus 的安全架构，包括传输安全、设备认证、三方安全边界，以及 bot 级可选端到端加密（**当前可选**，默认关闭）。

> **范围定调（已锁定）**：本期主线依旧是 **层级 A —— 传输安全 + 静态加密 + 设备认证**。
> **ACP 端点 E2EE 改为 bot 可选项**：默认关闭，默认行为等同明文；若 `binding_config.acp_security.enabled=true`，网关走可选协商通道（目前为字段下发，不含 payload 加解密）。
> 本文 §4（Daemon↔Agent E2EE）、§5（群聊 E2EE）、§6（E2EE 代价）仍为**未来计划设计存档**，本期不作为默认行为启用。
>
> ⚠️ **E2EE 与现有能力的硬冲突（实现 E2EE 前必须解决）**：[AGENT_BRIDGE_RESOURCE](./AGENT_BRIDGE_RESOURCE.md) 的 `channel.files.read`（返回文本/markdown）、`channel.context`（聚合明文）、以及服务端 RAG/全文搜索/历史摘要/文件转换，**全部依赖 Platform 能读明文**。一旦上群聊 E2EE（§5），这些服务端读取能力失效，须挪到客户端/Daemon 端（见 §6 的解决方案表）。本期保留这些服务端能力，因此本期不上 E2EE。

---

## 0. 决策摘要

| 维度 | 决策 | 状态 | 理由 |
|------|------|------|------|
| 传输安全 | TLS 1.3 + cert pinning | **本期** | 防窃听、防中间人 |
| 设备认证 | Ed25519 密钥对 + 设备证书 + 短期凭证 | **本期** | 双向认证，不可伪造 |
| bot 级 ACP 端点 E2EE | `binding_config.acp_security` 作为可选开关 | **可选（待实现）** | 先打通 control/data 握手，未默认加密 payload |
| Daemon ↔ Agent E2EE | ECDH 密钥协商 + AES-256-GCM | **未来计划** | Platform 看不到内容（与服务端读取冲突，本期不做） |
| 群聊 E2EE | Group Key 模型 | **未来计划** | 频道成员（含 Bot）持有 key，Platform 不持有 |
| 三方安全边界 | Platform/Daemon/Agent 各管各的，互不可绕过 | **本期** | 最小权限原则 |

---

## 1. 三方安全边界

### 1.1 控制范围

```
┌─ ACP Agent 控制 ────────────────────────────────────────────┐
│  · 实际执行什么操作                                          │
│  · Agent 内部确认流程                                        │
│  · Agent 内部工具权限                                        │
│  · 执行策略                                                  │
│                                                              │
│  ┌─ Daemon 控制 ──────────────────────────────────────────┐ │
│  │  · 哪些 ACP 事件能放行（事件过滤）                        │ │
│  │  · 本地资源目录/命令白名单                                │ │
│  │  · 设备认证（密钥对、证书、签名）                         │ │
│  │  · 确认协调                                              │ │
│  │  · E2EE 密钥持有                                         │ │
│  │                                                         │ │
│  │  ┌─ Platform 控制 ────────────────────────────────────┐ │ │
│  │  │  · Grant 签发/吊销/过期                              │ │ │
│  │  │  · Session 生命周期权限检查                           │ │ │
│  │  │  · Bot 配置变更权限检查                               │ │ │
│  │  │  · 业务逻辑（session/bot 所有权）                     │ │ │
│  │  │  · 审批流                                            │ │ │
│  │  │  · 设备注册验证                                      │ │ │
│  │  │  · 路由（根据元数据）                                 │ │ │
│  │  └─────────────────────────────────────────────────────┘ │ │
│  └───────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────┘
```

### 1.2 不可修改性

```
Platform 不可修改:
  · Daemon 的事件过滤策略
  · Daemon 的目录/命令白名单
  · Daemon 的设备私钥
  · Agent 的内部权限系统

Daemon 不可修改:
  · Platform 的 Grant 配置
  · Platform 的业务逻辑规则
  · Platform 的审批流配置

Agent 不可修改:
  · Platform 的 Grant 配置
  · Daemon 的事件过滤策略

任何一方都不可绕过其他方的控制。
```

---

## 2. 传输安全

### 2.1 TLS 1.3

所有 Daemon ↔ Platform 通信使用 TLS 1.3 加密。

### 2.2 Certificate Pinning

Daemon 硬编码 Platform 证书指纹，防止 CA 被攻破时的中间人攻击。

```jsonc
// ~/.agentnexus/daemon.json
{
  "platform": {
    "url": "wss://agentnexus.com",
    "cert_pinning": {
      "enabled": true,
      "sha256_pins": [
        "base64-encoded-sha256-of-cert-1",    // 主证书
        "base64-encoded-sha256-of-cert-2"     // 备用（轮换用）
      ]
    }
  }
}
```

---

## 3. 设备认证

### 3.1 双向认证

```
Daemon 验证 Platform:  TLS 证书 + cert pinning
Platform 验证 Daemon:  Ed25519 签名 + 设备注册 + 短期凭证
```

### 3.2 设备注册

```
Daemon 首次连接:
  1. Daemon 生成 Ed25519 密钥对（私钥不上传）
  2. Daemon → Platform: 注册请求 + 公钥 + 用户 token
  3. Platform: 创建 device 记录，签发设备证书
  4. Platform → Daemon: 设备证书 + 初始凭证
```

### 3.3 连接认证

```
Daemon 每次连接:
  1. TLS 握手 + Daemon 验证 Platform 证书（cert pinning）
  2. Daemon 签名:
     payload = {device_id, timestamp, nonce, platform_cert_fingerprint}
     signature = Ed25519.sign(device_private_key, payload)
  3. Daemon → Platform: {payload, signature}
  4. Platform 验证:
     - Ed25519 签名有效 ✓
     - timestamp 在 5 分钟内 ✓
     - nonce 未使用过 ✓
     - platform_cert_fingerprint 匹配 ✓
     - device 未被吊销 ✓
  5. Platform → Daemon: session token (1h 有效)
  6. 后续通信用 session token，过期前自动续期
```

### 3.4 防护总结

| 威胁 | 防护 |
|------|------|
| 恶意服务器冒充 Platform | TLS + cert pinning |
| 恶意客户端冒充 Daemon | Ed25519 签名 + 设备注册 |
| 中间人攻击 | TLS + 签名中包含 platform_cert_fingerprint |
| 重放攻击 | timestamp (5min) + nonce |
| 设备私钥泄露 | 用户可吊销设备 |
| session token 泄露 | 1h 过期 + 自动续期 |

---

## 4. Daemon ↔ Agent 端到端加密

> 🔮 **未来计划，本期不实现。** 以下为设计存档，供将来上 E2EE 时直接接续。本期 Daemon↔Agent 通信依赖 §2 传输安全（TLS 1.3）+ §3 设备认证，Platform 可见明文（用于路由、权限检查、resource 服务端读取）。

### 4.1 目标

Platform 路由消息但看不到内容。Daemon 和 Agent 共享加密密钥。

```
Daemon ←── E2EE ──→ Agent Service
         │
         └── Platform 只转发密文，看不到明文
```

### 4.2 密钥协商

```
Daemon                           Platform                           Agent Service
  │                                 │                                   │
  │  生成 ECDH 密钥对               │                                   │
  │                                 │                                   │
  │──daemon_pubkey─────────────────▶│──daemon_pubkey───────────────────▶│
  │                                 │                                   │
  │◀──agent_pubkey─────────────────│◀──agent_pubkey───────────────────│
  │                                 │                                   │
  │  shared_secret = ECDH(          │  (不知道 shared_secret)           ECDH(
  │    daemon_privkey,              │                                   agent_privkey,
  │    agent_pubkey)                │                                   daemon_pubkey)
  │                                 │                                   │
  │  e2ee_key = HKDF(shared_secret) │                                   e2ee_key = HKDF(shared_secret)
```

### 4.3 加密格式

```jsonc
// 明文元数据（Platform 可见，用于路由和权限检查）
{
  "type": "resource_req",
  "req_id": "r1",
  "session_id": "sess-abc",
  "bot_id": "bot-opencode",
  "resource": "local:files.read",
  "encrypted": true,

  // 加密内容（Platform 不可见）
  "ciphertext": "base64...",
  "nonce": "base64...",
  "tag": "base64..."
}
```

### 4.4 加密算法

```
密钥协商: ECDH P-256（或 X25519）
对称加密: AES-256-GCM（或 ChaCha20-Poly1305）
密钥派生: HKDF-SHA256(shared_secret, salt, info) → encryption_key
```

### 4.5 Daemon 的事件过滤

Daemon 持有 e2ee_key，能解密内容做事件过滤后重新加密：

```
Agent → Daemon: 加密消息
  │
  ▼ Daemon 解密（有 e2ee_key）
  │  plaintext = AES_GCM_decrypt(e2ee_key, ciphertext)
  │
  ▼ Daemon 事件过滤（看到明文）
  │  directory_check: 路径在白名单 ✓
  │
  ▼ Daemon 重新加密
  │  ciphertext' = AES_GCM_encrypt(e2ee_key, plaintext)
  │
  ▼ Daemon → Platform: 密文（Platform 看不到明文）
```

### 4.6 前向保密

每次 Daemon 重新连接，重新协商 ECDH 密钥。E2EE 密钥不持久化，会话结束废弃。

---

## 5. 群聊端到端加密

> 🔮 **未来计划，本期不实现。** 以下为设计存档。上群聊 E2EE 会使服务端全文搜索 / RAG / 历史摘要 / 文件转换 / 推送预览失效（见 §6），须先回答 [E2EE_NOTES.md](./E2EE_NOTES.md) 的 6 个待调研问题。

### 5.1 Group Key 模型

每个频道一个对称密钥，频道成员（含 Bot）持有，Platform 不持有。

```
Channel #dev-project
  │
  ├─ group_key (AES-256)
  │   ├─ 用户 A 持有 ✓
  │   ├─ 用户 B 持有 ✓
  │   ├─ Bot (via Daemon) 持有 ✓
  │   └─ Platform 不持有 ✗
```

### 5.2 Group Key 分发

```
用户 A 创建频道:
  1. 用户 A 生成 group_key
  2. 用户 A 用自己设备密钥加密 group_key，存储在本地

用户 B 加入:
  3. 用户 A 用 B 的公钥加密 group_key → 发给 B
  4. B 解密获得 group_key

Bot 加入:
  5. 用户 A 用 Bot 的公钥加密 group_key → 发给 Bot（via Platform 转发密文）
  6. Bot 解密获得 group_key
```

### 5.3 消息加密

```
用户 A 发消息:
  1. 用 group_key 加密内容
     ciphertext = AES_GCM_encrypt(group_key, "帮我重构 main.py")
  2. → Platform: {channel_id, sender_id, encrypted:true, ciphertext, nonce, tag}
  3. Platform 存储密文，推送成员
  4. 成员/Bot 用 group_key 解密
```

### 5.4 成员变更

```
新成员加入:
  - 现有成员用新成员公钥加密 group_key → 发给新成员
  - 不需要轮换 group_key

成员离开:
  - 生成新 group_key
  - 用剩余成员公钥加密新 group_key → 发给他们
  - 旧 group_key 废弃（前向保密）
```

### 5.5 Bot 参与 E2EE

```
Bot 收到加密消息:
  Daemon 用 group_key 解密 → 事件过滤 → 转发给 Agent
  Agent 处理 → 加密回复 → Daemon → Platform → 其他成员

Bot 和用户一样持有 group_key。
Platform 仍然看不到内容。
```

### 5.6 密钥持有者

| 实体 | 持有 group_key | 能解密 |
|------|:---:|:---:|
| 频道成员（用户） | ✅ | ✅ |
| Bot (via Daemon) | ✅ | ✅ |
| **Platform** | **❌** | **❌** |
| 未加入用户 | ❌ | ❌ |
| 离开成员（轮换后） | ❌ | ❌ |

---

## 6. E2EE 的代价

> 🔮 **未来计划。** 本表说明「为何本期不上 E2EE」：下列服务端能力本期都在用，E2EE 会让它们失效。

| 功能 | E2EE 前 | E2EE 后 |
|------|---------|---------|
| 全文搜索 | PG full-text | **不可用**（密文不可搜索） |
| RAG / embedding | 服务端做 | **不可用**（需要明文） |
| 历史摘要 | 服务端做 | **不可用**（需要明文） |
| 文件转换 | 服务端做 | **客户端或 Daemon 端做** |
| 管理员查看消息 | 可以 | **看不到内容** |
| 推送预览 | 有明文 | **无预览** |
| 审计日志 | 有内容 | **只有元数据** |

### 解决方案

| 功能 | 方案 |
|------|------|
| 搜索 | 客户端本地搜索（密文下载后本地解密建索引） |
| RAG | Daemon 端做（Daemon 有 group_key，能解密） |
| 历史摘要 | Daemon 端做 |
| 文件转换 | 客户端或 Daemon 端做 |

---

## 7. 三层安全架构

> 本期落地**外两层**（传输安全 + 设备认证）。内两层（端到端加密、群聊 E2EE）为未来计划，图中以虚线语义标注。

```
┌─ 传输安全 ──────────────────────────────────────────────────┐
│  TLS 1.3 + cert pinning                                     │
│  防窃听、防中间人                                             │
│                                                              │
│  ┌─ 设备认证 ──────────────────────────────────────────────┐ │
│  │  Ed25519 签名 + 设备证书 + 短期凭证                      │ │
│  │  双向认证，不可伪造                                       │ │
│  │                                                         │ │
│  │  ┌─ 端到端加密 ────────────────────────────────────────┐ │ │
│  │  │  ECDH 密钥协商 + AES-256-GCM                        │ │ │
│  │  │  Daemon ↔ Agent E2EE（Platform 看不到内容）          │ │ │
│  │  │                                                     │ │ │
│  │  │  ┌─ 群聊 E2EE ────────────────────────────────────┐ │ │ │
│  │  │  │  Group Key 模型                                 │ │ │ │
│  │  │  │  频道成员 + Bot 持有 key，Platform 不持有        │ │ │ │
│  │  │  └─────────────────────────────────────────────────┘ │ │ │
│  │  └─────────────────────────────────────────────────────┘ │ │
│  └───────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────┘
```

---

## 8. 实现阶段

> 阶段命名与 [E2EE_NOTES.md](./E2EE_NOTES.md) 的「层级 A/B/C」是**两套不同的 taxonomy**，勿混淆：
> - 本文「阶段 A–E」是**安全工程实现阶段**（传输 → 设备认证 → E2EE → 群聊 E2EE → 元数据）。
> - E2EE_NOTES「层级 A/B/C」是**威胁模型层级**（A=传输+静态、B=人-人 E2EE、C=ACP 端点 E2EE）。
> - 对应关系：本期 = 本文阶段 A+B = E2EE_NOTES 层级 A。本文阶段 C/D ⊂ E2EE_NOTES 层级 B/C（均未来计划）。

| 阶段 | 内容 | 状态 |
|------|------|------|
| **A. 传输+静态加密** | TLS 1.3 + 磁盘加密 | **本期**（现有基础，本次重构推进） |
| **B. 设备认证** | Ed25519 密钥对 + 设备证书 + cert pinning | **本期** |
| **C. Daemon ↔ Agent E2EE** | ECDH + AES-256-GCM | **未来计划**（与服务端读取冲突，见 §6） |
| **D. 群聊 E2EE** | Group Key 模型 | **未来计划** |
| **E. 元数据保护** | sealed sender 等 | 超范围，暂不考虑 |
