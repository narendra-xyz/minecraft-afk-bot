const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mineflayer = require('mineflayer');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

let bot = null;
let botConfig = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let afkInterval = null;
let isRunning = false;
let logs = [];

const MAX_LOGS = 200;

function addLog(msg, type = 'info') {
  const entry = { msg, type, time: new Date().toLocaleTimeString('id-ID') };
  logs.push(entry);
  if (logs.length > MAX_LOGS) logs.shift();
  io.emit('log', entry);
}

function getBotStatus() {
  if (!bot) return 'offline';
  if (bot.entity) return 'online';
  return 'connecting';
}

function emitStatus() {
  io.emit('status', {
    status: getBotStatus(),
    config: botConfig,
    reconnectAttempts,
    health: bot?.health ?? 0,
    food: bot?.food ?? 0,
    position: bot?.entity?.position ?? null,
    username: bot?.username ?? null,
  });
}

function randomDelay(min = 800, max = 3000) {
  return new Promise(resolve =>
    setTimeout(resolve, Math.floor(Math.random() * (max - min + 1)) + min)
  );
}

const AFK_ACTIONS = [
  async () => {
    if (!bot?.entity) return;
    const yaw = Math.random() * Math.PI * 2;
    const pitch = (Math.random() - 0.5) * Math.PI * 0.5;
    await bot.look(yaw, pitch, true);
    addLog(`👀 Melihat ke arah (${yaw.toFixed(2)}, ${pitch.toFixed(2)})`, 'action');
  },
  async () => {
    if (!bot?.entity) return;
    bot.setControlState('jump', true);
    await randomDelay(100, 300);
    bot.setControlState('jump', false);
    addLog('⬆️ Lompat', 'action');
  },
  async () => {
    if (!bot?.entity) return;
    const dirs = ['forward', 'back', 'left', 'right'];
    const dir = dirs[Math.floor(Math.random() * dirs.length)];
    bot.setControlState(dir, true);
    await randomDelay(400, 1200);
    bot.setControlState(dir, false);
    addLog(`🚶 Bergerak: ${dir}`, 'action');
  },
  async () => {
    if (!bot?.entity) return;
    bot.swingArm();
    addLog('✊ Ayun tangan', 'action');
  },
  async () => {
    if (!bot?.entity) return;
    bot.setControlState('sneak', true);
    await randomDelay(500, 1500);
    bot.setControlState('sneak', false);
    addLog('🦆 Jongkok sebentar', 'action');
  },
];

async function runAfkLoop() {
  if (!isRunning || !bot?.entity) return;
  const action = AFK_ACTIONS[Math.floor(Math.random() * AFK_ACTIONS.length)];
  try { await action(); } catch (e) { addLog(`⚠️ AFK error: ${e.message}`, 'warn'); }
  const delay = Math.floor(Math.random() * 8000) + 4000;
  afkInterval = setTimeout(runAfkLoop, delay);
}

function stopAfk() {
  isRunning = false;
  if (afkInterval) { clearTimeout(afkInterval); afkInterval = null; }
  if (bot?.entity) {
    ['forward','back','left','right','jump','sneak','sprint'].forEach(k =>
      bot.setControlState(k, false)
    );
  }
}

function destroyBot() {
  stopAfk();
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (bot) {
    try { bot.quit('Stopping bot'); } catch (_) {}
    bot.removeAllListeners();
    bot = null;
  }
}

function scheduleReconnect() {
  if (!botConfig?.autoReconnect) return;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  const delay = Math.floor(Math.random() * 9000) + 1000;
  reconnectAttempts++;
  addLog(`🔄 Reconnect #${reconnectAttempts} dalam ${delay / 1000}s...`, 'info');
  reconnectTimer = setTimeout(() => createBot(botConfig), delay);
  emitStatus();
}

function createBot(config) {
  if (bot) destroyBot();
  botConfig = config;
  addLog(`🔌 Menghubungkan ke ${config.host}:${config.port} sebagai ${config.username}...`, 'info');
  emitStatus();
  try {
    bot = mineflayer.createBot({
      host: config.host,
      port: parseInt(config.port) || 25565,
      username: config.username,
      version: config.version || false,
      auth: config.auth || 'offline',
      hideErrors: false,
      checkTimeoutInterval: 30000,
      keepAlive: true,
    });
  } catch (e) {
    addLog(`❌ Gagal membuat bot: ${e.message}`, 'error');
    scheduleReconnect();
    return;
  }
  bot.on('login', () => {
    reconnectAttempts = 0;
    addLog(`✅ Login berhasil sebagai ${bot.username}`, 'success');
    emitStatus();
    if (config.afkEnabled) { isRunning = true; runAfkLoop(); }
  });
  bot.on('spawn', () => {
    addLog('🌍 Bot di-spawn', 'info');
    emitStatus();
    setTimeout(() => {
      bot.chat('/login Pito#123');
      addLog('🔑 Auto-login terkirim', 'action');
    }, 1000);
  });
  bot.on('health', () => emitStatus());
  bot.on('chat', (username, message) => {
    if (username === bot.username) return;
    addLog(`💬 [${username}]: ${message}`, 'chat');
    io.emit('chat', { username, message, time: new Date().toLocaleTimeString('id-ID') });
  });
  bot.on('message', (jsonMsg) => {
    const msg = jsonMsg.toString();
    addLog(`📨 [SYSTEM]: ${msg}`, 'chat');
    io.emit('chat', { username: 'SYSTEM', message: msg, time: new Date().toLocaleTimeString('id-ID') });
  });
  bot.on('kicked', (reason) => {
    addLog(`⛔ Di-kick: ${JSON.stringify(reason)}`, 'error');
    stopAfk(); emitStatus(); scheduleReconnect();
  });
  bot.on('end', (reason) => {
    addLog(`🔴 Terputus: ${reason || 'unknown'}`, 'warn');
    stopAfk(); emitStatus();
    if (botConfig?.autoReconnect) scheduleReconnect();
  });
  bot.on('error', (err) => addLog(`❌ Error: ${err.message}`, 'error'));
  bot.on('death', () => {
    addLog('💀 Bot mati!', 'warn');
    stopAfk();
    setTimeout(() => { if (bot?.entity) { isRunning = true; runAfkLoop(); } }, 3000);
  });
}

io.on('connection', (socket) => {
  addLog('🖥️ Panel terhubung', 'info');
  socket.emit('init', { logs, status: getBotStatus(), config: botConfig });
  emitStatus();
  socket.on('connect_bot', (config) => {
    if (!config.host || !config.username) return socket.emit('error_msg', 'Host dan username wajib!');
    createBot({ ...config, autoReconnect: config.autoReconnect ?? true, afkEnabled: config.afkEnabled ?? true });
  });
  socket.on('disconnect_bot', () => {
    botConfig = { ...botConfig, autoReconnect: false };
    destroyBot();
    addLog('🛑 Bot dihentikan', 'info');
    emitStatus();
  });
  socket.on('send_chat', async (msg) => {
    if (!bot?.entity || !msg) return;
    await randomDelay(300, 1200);
    bot.chat(msg);
    addLog(`📤 Chat: ${msg}`, 'action');
  });
  socket.on('send_command', async (cmd) => {
    if (!bot?.entity || !cmd) return;
    await randomDelay(200, 800);
    bot.chat(cmd.startsWith('/') ? cmd : '/' + cmd);
    addLog(`⚡ Command: ${cmd}`, 'action');
  });
  socket.on('toggle_afk', () => {
    if (!bot?.entity) return;
    if (isRunning) { stopAfk(); addLog('⏸️ AFK stop', 'info'); }
    else { isRunning = true; runAfkLoop(); addLog('▶️ AFK start', 'info'); }
    io.emit('afk_state', isRunning);
  });
  socket.on('manual_action', async (action) => {
    if (!bot?.entity) return;
    await randomDelay(200, 600);
    switch (action) {
      case 'jump': bot.setControlState('jump', true); await randomDelay(100,200); bot.setControlState('jump', false); addLog('⬆️ Lompat', 'action'); break;
      case 'sneak': bot.setControlState('sneak', true); await randomDelay(800,2000); bot.setControlState('sneak', false); addLog('🦆 Jongkok', 'action'); break;
      case 'attack': bot.attack(bot.nearestEntity()); addLog('⚔️ Serang', 'action'); break;
      case 'look_around': await bot.look(Math.random() * Math.PI * 2, 0, true); addLog('👀 Lihat', 'action'); break;
      case 'respawn': bot.respawn?.(); addLog('♻️ Respawn', 'action'); break;
    }
  });
  socket.on('get_status', () => emitStatus());
});

app.get('/health', (_, res) => res.json({ ok: true, bot: getBotStatus() }));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Server jalan di port ${PORT}`));
