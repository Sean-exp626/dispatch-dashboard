#!/bin/bash
# Claude Code hook → Dispatch Dashboard
# Reads event JSON from stdin, POSTs to the dashboard server.
# Fire-and-forget: never blocks Claude Code.

EVENT_DATA=$(cat)

curl -s -X POST "http://localhost:3000/api/event" \
  -H "Content-Type: application/json" \
  -d "$EVENT_DATA" > /dev/null 2>&1 &

exit 0
