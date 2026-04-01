curl -sS http://152.136.246.214:18101/v1/chat/completions \
  -H 'Authorization: Bearer REDACTED_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "messages": [{"role":"user","content":"hello"}],