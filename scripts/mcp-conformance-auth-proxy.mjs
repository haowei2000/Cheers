#!/usr/bin/env node

import http from "node:http";

const target = process.env.CHEERS_MCP_TARGET;
const token = process.env.CHEERS_MCP_ACCESS_TOKEN;
const port = Number(process.env.CHEERS_MCP_PROXY_PORT || "39091");
const maxBodyBytes = 1024 * 1024;

if (!target || !token) {
  console.error(
    "CHEERS_MCP_TARGET and CHEERS_MCP_ACCESS_TOKEN are required",
  );
  process.exit(2);
}

const targetUrl = new URL(target);

const server = http.createServer((request, response) => {
  const chunks = [];
  let size = 0;

  request.on("data", (chunk) => {
    size += chunk.length;
    if (size > maxBodyBytes) {
      response.writeHead(413).end();
      request.destroy();
      return;
    }
    chunks.push(chunk);
  });

  request.on("end", async () => {
    if (response.writableEnded) return;
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (
          value === undefined ||
          ["authorization", "content-length", "host"].includes(name)
        ) {
          continue;
        }
        headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      headers.set("authorization", `Bearer ${token}`);

      const upstream = await fetch(targetUrl, {
        method: request.method,
        headers,
        body:
          request.method === "GET" || request.method === "HEAD"
            ? undefined
            : Buffer.concat(chunks),
        redirect: "manual",
      });
      const responseHeaders = {};
      upstream.headers.forEach((value, name) => {
        if (!["connection", "content-length", "transfer-encoding"].includes(name)) {
          responseHeaders[name] = value;
        }
      });
      response.writeHead(upstream.status, responseHeaders);
      response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      response.writeHead(502, { "content-type": "application/json" });
      response.end('{"detail":"upstream unavailable"}');
    }
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`MCP conformance auth proxy listening on http://127.0.0.1:${port}/mcp`);
});
