curl -sS http://152.136.246.214:18101/v1/chat/completions \
  -H 'Authorization: Bearer gX8HZEVPCiTR-zwbXRJe2lIOgfViEnA6Xe5zIiaow4o' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "messages": [{"role":"user","content":"hello"}],