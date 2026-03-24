curl -sS http://10.1.8.251:18789/v1/chat/completions \
  -H 'Authorization: Bearer REDACTED_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "messages": [{"role":"user","content":"hello"}],
    "stream": true
  }'
