#!/usr/bin/env python3
"""Deterministic LOCAL ACP fixture, not an LLM. Uses the real Cheers HTTP MCP
server supplied by the Rust connector; never reads production credentials.
"""
import copy
import html
import json
import re
import sys
import urllib.request
import urllib.error
import uuid

SESSIONS = {}


def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def tool(session, name, arguments):
    server = next(s for s in session["mcpServers"] if s.get("name", "").startswith("cheers"))
    headers = {h["name"]: h["value"] for h in server.get("headers", [])}
    headers.update({"Content-Type": "application/json", "Accept": "application/json, text/event-stream",
                    "MCP-Protocol-Version": "2026-07-28", "MCP-Method": "tools/call", "MCP-Name": name})
    payload = {"jsonrpc": "2.0", "id": str(uuid.uuid4()), "method": "tools/call", "params": {"name": name, "arguments": arguments,
        "_meta": {"io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {}}}}
    request = urllib.request.Request(server["url"], json.dumps(payload).encode(), headers)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read().decode()
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"MCP {name}: HTTP {error.code}: {error.read().decode()}") from error
    if raw.startswith("event:") or raw.startswith("data:"):
        raw = next(line[6:] for line in raw.splitlines() if line.startswith("data: "))
    result = json.loads(raw)
    if "error" in result:
        raise RuntimeError(str(result["error"]))
    result = result["result"]
    if result.get("isError"):
        raise RuntimeError(str(result.get("content")))
    if "structuredContent" in result:
        return result["structuredContent"]
    text = next(part["text"] for part in result["content"] if part.get("type") == "text")
    return json.loads(text)


def text_node(identity, text):
    return {"id": identity, "component": "Text", "text": text}


def write(session, channel, path, document):
    try:
        current = tool(session, "desk_read", {"channel_id": channel, "path": path})
        version = current["version"]
    except RuntimeError as error:
        if "NOT_FOUND" not in str(error):
            raise
        version = 0
    return tool(session, "desk_write", {"channel_id": channel, "path": path,
        "content": document if isinstance(document, str) else json.dumps(document, ensure_ascii=False, indent=2), "if_version": version})


def demo_documents(contract):
    report = copy.deepcopy(contract["request_example"])
    nodes = report["messages"][1]["updateComponents"]["components"]
    nodes[1]["text"] = "报告申请 · 本地演示"
    nodes[2]["text"] = "这是确定性 ACP 演示 Bot。提交后会更新同一份资源，不调用外部模型。"
    nodes[3]["label"] = "报告主题"
    nodes[4]["label"] = "包含参考资料"
    nodes[6]["label"] = "提交报告申请"
    nodes[0]["children"].insert(0, "status")
    next(n for n in nodes if n["id"] == "summary")["children"].insert(0, "status")
    nodes.append(text_node("status", "状态：等待提交"))
    report["messages"][2]["updateDataModel"]["value"]["report"]["topic"] = "智能卡片与统一资源链路"

    complex_form = copy.deepcopy(report)
    complex_form.pop("views")
    components = complex_form["messages"][1]["updateComponents"]["components"]
    components[1]["text"] = "复杂表单 · 请在回复内展开"
    for at, label in enumerate(["目标读者", "输出格式", "交付日期", "补充说明"]):
        identity = f"extra-{at}"
        components.append({"id": identity, "component": "TextField", "label": label, "value": {"path": f"/report/{identity}"}})
        components[0]["children"].insert(-1, identity)
        components[6]["action"]["event"]["context"]["payload"][identity] = {"path": f"/report/{identity}"}
        complex_form["messages"][2]["updateDataModel"]["value"]["report"][identity] = "待填写"

    native = {"a2ui": "v0.9.1", "messages": [
        {"version": "v0.9.1", "createSurface": {"surfaceId": "native", "catalogId": contract["catalog_id"]}},
        {"version": "v0.9.1", "updateComponents": {"surfaceId": "native", "components": [
            {"id": "root", "component": "Column", "children": ["note", "open"]},
            text_node("note", "在 Finder 打开演示文档的下载副本。外部修改不会自动回写。"),
            {"id": "open", "component": "Button", "label": "在 Finder 打开文档副本",
             "action": {"event": {"name": "cheers.openNative", "context": {"uri": "cheers:desk/demo/notes.md", "opener": "finder"}}}}
        ]}}]}
    return {"demo/report.a2ui.json": report, "demo/complex.a2ui.json": complex_form,
        "demo/native.a2ui.json": native,
        "demo/notes.md": "# 智能卡片演示\n\n这是一份普通 Desk 文档，回复内可预览。\n\n- 小表单：直接提交。\n- 复杂表单：展开后操作。\n- 原始源码与预览共用版本。\n- 桌面打开副本不隐式回写。\n",
        "demo/safe-source.html": "<h1>源码安全预览</h1>\n<script>/* 不在消息内执行 */</script>\n"}


def prompt(session_id, params):
    session = SESSIONS[session_id]
    content = "\n".join(part.get("text", "") for part in params.get("prompt", []) if part.get("type") == "text")
    channel = re.search(r"channel_id=([0-9a-f-]{36})", html.unescape(content))[1]
    msg = re.search(r"current reply message id is ([0-9a-f-]{36})", content)[1]
    interaction = re.search(r'<interaction trust="user-data">(.*?)</interaction>', content, re.S)
    if interaction:
        event = json.loads(html.unescape(interaction[1]))
        source = tool(session, "read_locator", {"channel_id": channel, "uri":event["sourceUri"]})
        path = source["path"]
        if source["version"] != event["sourceVersion"]:
            message = "资源版本已变化，请刷新卡片后重试。"
        else:
            document = source.get("data") or json.loads(source["content"])
            for node in document["messages"][1]["updateComponents"]["components"]:
                if node["id"] == "status":
                    node["text"] = f"状态：演示处理完成 · 主题：{event['input'].get('topic', '')}"
            document["messages"][2]["updateDataModel"]["value"]["report"].update(event["input"])
            # Revalidate sourceVersion atomically in the same authorized write.
            tool(session, "desk_write", {"channel_id": channel, "path": path,
                "content": json.dumps(document, ensure_ascii=False, indent=2), "if_version": event["sourceVersion"]})
            message = "演示 Bot 已接收结构化输入并更新同一资源。卡片状态和版本现在会刷新。"
        cards = [{"v": 1, "kind": "resource_ref", "uri": event["sourceUri"], "title": "已更新的表单"}]
    else:
        contract = tool(session, "read_ui_contract", {})
        documents = demo_documents(contract)
        bot = contract["request_example"]["messages"][1]["updateComponents"]["components"][6]["action"]["event"]["context"]["botId"]
        documents["demo/terminal.a2ui.json"] = {"a2ui":"v0.9.1","messages":[
            {"version":"v0.9.1","createSurface":{"surfaceId":"terminal","catalogId":contract["catalog_id"]}},
            {"version":"v0.9.1","updateComponents":{"surfaceId":"terminal","components":[
                {"id":"root","component":"Column","children":["note","command","run"]},
                text_node("note","真实远程终端 · 需确认目标设备。命令使用该设备账户权限。"),
                {"id":"command","component":"TextField","label":"命令（可跨设备恢复草稿）","value":{"path":"/command"}},
                {"id":"run","component":"Button","label":"运行终端命令","action":{"event":{"name":"cheers.execute","context":{"actionId":"terminal.run","botId":bot,"payload":{"action":"terminal.start","path":"","command":{"path":"/command"}}}}}}
            ]}},
            {"version":"v0.9.1","updateDataModel":{"surfaceId":"terminal","path":"/","value":{"command":"printf 'Cheers terminal ready\\n'"}}}
        ]}
        identities = {path:write(session, channel, path, document)["uri"] for path,document in documents.items()}
        more = "其它" in html.unescape(content)
        paths = [("demo/notes.md", "普通文档预览"), ("demo/safe-source.html", "HTML 源码安全预览")] if more else [
            ("demo/report.a2ui.json", "报告申请 · 可直接提交"), ("demo/complex.a2ui.json", "复杂表单 · 在回复内展开"), ("demo/native.a2ui.json", "桌面打开 · Finder 副本")]
        if "终端" in html.unescape(content): paths=[("demo/terminal.a2ui.json","真实终端 · 设备确认"),("demo/report.a2ui.json","跨设备草稿 · 报告申请")]
        cards = [{"v": 1, "kind": "resource_ref", "uri": identities[path], "title": title} for path, title in paths]
        message = "已生成本地演示数据。小表单可直接操作，复杂表单可展开，桌面动作会打开下载副本。此 Bot 是确定性 ACP 测试 agent，不调用外部模型。"
    tool(session, "set_resource_cards", {"channel_id": channel, "msg_id": msg, "cards_json": json.dumps(cards, ensure_ascii=False)})
    emit({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": session_id,
        "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": message}}}})
    return {"stopReason": "end_turn"}


def main():
    for line in sys.stdin:
        try:
            request = json.loads(line)
            method, params = request.get("method"), request.get("params", {})
            if "id" not in request:
                continue
            if method == "initialize":
                result = {"protocolVersion": params.get("protocolVersion", 1), "agentCapabilities": {"mcpCapabilities": {"http": True}},
                    "agentInfo": {"name": "cheers-local-ui-fixture", "version": "1.0.0"}, "authMethods": []}
            elif method == "session/new":
                identity = str(uuid.uuid4()); SESSIONS[identity] = params; result = {"sessionId": identity}
            elif method == "session/prompt":
                result = prompt(params["sessionId"], params)
            elif method == "authenticate":
                result = {}
            else:
                emit({"jsonrpc": "2.0", "id": request["id"], "error": {"code": -32601, "message": f"Fixture does not implement {method}"}})
                continue
            emit({"jsonrpc": "2.0", "id": request["id"], "result": result})
        except Exception as error:
            # Keep details off stdout (ACP framing). No credentials are logged.
            emit({"jsonrpc": "2.0", "id": request.get("id"), "error": {"code": -32603, "message": f"Local demo failed: {type(error).__name__}: {error}"}})


if __name__ == "__main__":
    main()
