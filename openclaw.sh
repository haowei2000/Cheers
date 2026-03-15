curl -sS http://10.1.8.251:18789/v1/chat/completions \
  -H 'Authorization: Bearer 51FD381E-5D37-4E2F-96E8-E892CBA9859E' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "messages": [{"role":"user","content":"hello"}],
    "stream": true
  }'
