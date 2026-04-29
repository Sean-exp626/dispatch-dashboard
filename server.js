const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');
const os = require('os');
const qrcode = require('qrcode-terminal');
const { runPipeline } = require('./pipeline');
const pipelineSSE    = require('./api/pipeline');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

const MAX_LOGS = 500;
const MAX_COMMANDS = 30;
const MAX_FILES = 100;

const state = {
  currentCommand: null,
  commands: [],
  readFiles: [],
  writtenFiles: [],
  logs: [],
  connectedAt: new Date().toISOString(),
  eventCount: 0,
};

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

function broadcast(data) {
  const message = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

function addLog(entry) {
  state.logs.unshift(entry);
  if (state.logs.length > MAX_LOGS) {
    state.logs = state.logs.slice(0, MAX_LOGS);
  }
}

function addCommand(command, timestamp) {
  state.commands.unshift({ command: command.substring(0, 500), timestamp });
  if (state.commands.length > MAX_COMMANDS) state.commands.pop();
}

function addReadFile(path) {
  state.readFiles = [path, ...state.readFiles.filter((f) => f !== path)].slice(0, MAX_FILES);
}

function addWrittenFile(path) {
  state.writtenFiles = [path, ...state.writtenFiles.filter((f) => f !== path)].slice(0, MAX_FILES);
}

// WebSocket — send current state on connect
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'init', state }));
  ws.on('error', () => {});
});

// Main event intake from hooks
app.post('/api/event', (req, res) => {
  const body = req.body;
  const timestamp = new Date().toISOString();
  state.eventCount++;

  const hookEvent = body.hook_event_name || body.event || 'unknown';
  const toolName = body.tool_name || '';
  const toolInput = body.tool_input || {};

  const logEntry = { timestamp, hookEvent, toolName, label: '', level: 'info' };

  if (hookEvent === 'PreToolUse') {
    if (toolName === 'Bash' && toolInput.command) {
      state.currentCommand = { command: toolInput.command, timestamp };
      addCommand(toolInput.command, timestamp);
      logEntry.label = `[Bash] ${toolInput.command.replace(/\n/g, ' ').substring(0, 120)}`;
      logEntry.level = 'cmd';
    } else if (toolName === 'Read' && toolInput.file_path) {
      addReadFile(toolInput.file_path);
      logEntry.label = `[Read] ${toolInput.file_path}`;
      logEntry.level = 'read';
    } else if (toolName === 'Edit' && toolInput.file_path) {
      addWrittenFile(toolInput.file_path);
      logEntry.label = `[Edit] ${toolInput.file_path}`;
      logEntry.level = 'write';
    } else if (toolName === 'Write' && toolInput.file_path) {
      addWrittenFile(toolInput.file_path);
      logEntry.label = `[Write] ${toolInput.file_path}`;
      logEntry.level = 'write';
    } else if (toolName === 'Grep') {
      logEntry.label = `[Grep] "${toolInput.pattern || ''}" in ${toolInput.path || '.'}`;
      logEntry.level = 'search';
    } else if (toolName === 'Glob') {
      logEntry.label = `[Glob] ${toolInput.pattern || ''} in ${toolInput.path || '.'}`;
      logEntry.level = 'search';
    } else if (toolName === 'Agent') {
      logEntry.label = `[Agent] ${toolInput.description || toolInput.subagent_type || 'spawning'}`;
      logEntry.level = 'agent';
    } else if (toolName === 'WebFetch' || toolName === 'WebSearch') {
      logEntry.label = `[${toolName}] ${toolInput.url || toolInput.query || ''}`;
      logEntry.level = 'web';
    } else {
      logEntry.label = `[${toolName || 'Tool'}] PreToolUse`;
      logEntry.level = 'info';
    }
  } else if (hookEvent === 'PostToolUse') {
    if (toolName === 'Bash') {
      state.currentCommand = null;
    }
    logEntry.label = `[${toolName || 'Tool'}] done`;
    logEntry.level = 'done';
  } else if (hookEvent === 'Stop') {
    state.currentCommand = null;
    logEntry.label = '[Session] Stopped';
    logEntry.level = 'stop';
  } else if (hookEvent === 'SubagentStop') {
    logEntry.label = '[Agent] Subagent stopped';
    logEntry.level = 'stop';
  } else if (hookEvent === 'Notification') {
    logEntry.label = `[Notify] ${body.message || ''}`;
    logEntry.level = 'notify';
  } else {
    logEntry.label = `[${hookEvent}] ${toolName || ''}`.trim();
    logEntry.level = 'info';
  }

  addLog(logEntry);
  broadcast({ type: 'update', state });
  res.json({ ok: true });
});

// Clear all state
app.post('/api/clear', (req, res) => {
  state.currentCommand = null;
  state.commands = [];
  state.readFiles = [];
  state.writtenFiles = [];
  state.logs = [];
  state.eventCount = 0;
  broadcast({ type: 'update', state });
  res.json({ ok: true });
});

// Team Coconut — 3-stage multi-agent pipeline (SSE streaming)
app.post('/api/pipeline', pipelineSSE);

// Health / stats
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    clients: wss.clients.size,
    eventCount: state.eventCount,
    uptime: process.uptime(),
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
  const localIP = getLocalIP();
  const networkURL = `http://${localIP}:${PORT}`;
  const localURL = `http://localhost:${PORT}`;

  console.log('\n' + '━'.repeat(50));
  console.log('  🖥  Dispatch Dashboard — Claude Code Monitor');
  console.log('━'.repeat(50));
  console.log(`\n  Local:    ${localURL}`);
  console.log(`  Network:  ${networkURL}\n`);
  console.log('  Scan to open on mobile:\n');
  qrcode.generate(networkURL, { small: true });
  console.log('━'.repeat(50));
  console.log('  Hook setup: add to ~/.claude/settings.json');
  console.log('  See hooks/claude-hook.sh for the script');
  console.log('━'.repeat(50) + '\n');
});
