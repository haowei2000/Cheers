# AgentNexus 外网连接 OpenClaw

## 整体流程

1. **步骤一：OpenClaw 开启 HTTP 端口**
   1. 进入 OpenClaw 设置界面
   2. 开启 HTTP API 端口（默认端口：18789）![openclaw-http-api-enable](imgs/openclaw_http_endpoint.png "openclaw-http-api-enable")
   3. 设置监听地址为 `0.0.0.0`，允许局域网访问
      ```shell
      openclaw config set gateway.bind lan
      ```
   4. 保存并重启 OpenClaw 服务
      ```shell
      openclaw gateway restart
      ```
   5. 验证：局域网内能否访问 `http://<本机IP>:18789`且执行以下命令；若不通则返回第 3 步检查配置  
      **请记住替换你的token**
      ```shell
      curl -sS http://127.0.0.1:18789/v1/chat/completions \
        -H 'Authorization: Bearer <Please provide your OpenClaw API key here>' \
        -H 'Content-Type: application/json' \
        -H 'x-openclaw-agent-id: main' \
        -d '{
          "model": "openclaw",
          "messages": [{"role":"user","content":"hello"}],
          "stream": true
        }'
      ```

2. **步骤二：配置 Nginx 中转汇聚**
   1. 安装 Nginx
   2. 编写反向代理配置，将外网域名/端口转发至各内网 OpenClaw 实例
      [nginx 配置示例](nginx_example.conf)

   3. 重载 Nginx 配置：`nginx -s reload`
   4. 验证：外网能否通过 Nginx 访问各 OpenClaw；若不通则返回第 2 步检查配置

3. **步骤三：AgentNexus 内配置**
   1. 进入 AgentNexus 管理后台
   2. 导航至 **Admin > AI 模型**，新增 AI Model，填写：
      - Provider: `openai-compatible`
      - Base URL: `https://<nginx域名>/api/bot1/v1`
      - Model Name: `openclaw`
      - API Key: 填写 <openclaw token>
      ![openclaw-config](imgs/openclaw_config.png "openclaw-config")
   3. 保存 AI Model 配置
   4. 导航至 **Bots**，新建或编辑 Bot，关联上述 AI Model 并设置对应的 Prompt Template
   5. 保存 Bot 配置
   6. 在频道中 `@mention` 该 Bot，验证是否正常响应；若异常则检查 **Admin > Logs** 排查错误后返回第 2 步

## 步骤详解

### 步骤一：OpenClaw 开启 HTTP 端口并配置局域网访问

1. 打开 OpenClaw 设置界面
2. 找到 **API / HTTP 服务** 配置项，开启 HTTP 端口（默认 `11434`）
3. 将监听地址设置为 `0.0.0.0`（允许来自局域网的请求）
4. 保存配置并重启 OpenClaw 服务
5. 在局域网内的另一台设备上访问 `http://<OpenClaw主机IP>:11434` 验证连通性

> **注意**：若有防火墙，需放行对应端口。

---

### 步骤二：配置 Nginx 中转汇聚

目的：将多台内网 OpenClaw 实例统一暴露为一个外网访问入口。

**示例 [Nginx 配置](nginx_example.conf)：**


配置完成后执行：

```bash
nginx -t        # 验证配置语法
nginx -s reload # 热重载
```

---

### 步骤三：AgentNexus 内配置

1. 登录 AgentNexus，进入 **Admin** 管理面板
2. 在 **LLM Providers / AI Models** 中新增模型：
   - **Base URL**：`https://<your-host>/api/bot1/v1`
   - **Model Name**：`openclaw`
   - **Provider**：`openai-compatible`
   - **API Key**： `<openclaw token>`
   - **额外请求 Headers** `{"x-openclaw-agent-id": "main"}`
   ![openclaw-config](imgs/config_ai_model.png "openclaw-config")
3. 保存后，在 **Bots** 中新建或编辑 Bot，关联上述 AI Model 及对应的 Prompt Template
4. 在频道中 `@mention` 该 Bot，确认能收到正常回复
5. 如出现异常，可在 **Admin > Logs** 查看调用日志排查问题
