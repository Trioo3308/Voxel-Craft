/**
 * host.mjs — Serve the game on your network, and relay multiplayer through it.
 *
 *   npm run host              (port 5173)
 *   npm run host -- 8080      (custom port)
 *
 * Three things on one port, with nothing to install (Node's own modules only):
 *   - the game's files, to anyone on your network;
 *   - /mp, a WebSocket relay: in multiplayer (src/net/) the host's browser and
 *     each guest's connect here and it passes messages between them, which
 *     works on any home network since nobody has to reach anybody else;
 *   - /api/signal, the same small mailbox the live site runs as a Netlify
 *     Function (netlify/functions/signal.mts), so browser-to-browser joining
 *     can be tried locally too.
 *
 * Why this rather than a plain static server:
 *   - It refuses to start on a busy port instead of silently moving to a random
 *     one. A random port breaks the link you already sent and does not match
 *     your firewall rule.
 *   - It prints the LAN address, and makes clear that `localhost` links only
 *     ever work on this machine.
 */

import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const DEFAULT_PORT = 5173;
const projectRoot = path.resolve(import.meta.dirname, '..');

const arg = process.argv[2];
const port = Number(arg ?? process.env.PORT ?? DEFAULT_PORT);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`\n  "${arg}" is not a valid port.\n`);
  process.exit(1);
}

/** Can we actually bind this port on all interfaces? */
function portIsFree(p) {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', () => resolve(false));
    tester.once('listening', () => tester.close(() => resolve(true)));
    tester.listen(p, '0.0.0.0');
  });
}

/** Real LAN addresses, skipping virtual adapters that peers cannot reach. */
function lanAddresses() {
  const found = [];
  for (const [name, infos] of Object.entries(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      if (/^(vEthernet|WSL|Docker|VirtualBox|VMware|Loopback|Hyper-V)/i.test(name)) continue;
      if (info.address.startsWith('169.254.')) continue;
      found.push({ name, address: info.address });
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function serveFile(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  // Nothing outside the project, and no hidden files (.git, .claude and so on).
  if (rel.split('/').some((part) => part.startsWith('.') && part !== '')) {
    res.writeHead(404).end();
    return;
  }
  let file = path.join(projectRoot, rel);
  if (file !== projectRoot && !file.startsWith(projectRoot + path.sep)) {
    res.writeHead(404).end();
    return;
  }
  fs.stat(file, (error, stat) => {
    if (!error && stat.isDirectory()) {
      file = path.join(file, 'index.html');
      stat = fs.existsSync(file) ? fs.statSync(file) : null;
    }
    if (error || !stat || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': stat.size,
      // Always the current files: an update shows up on the next reload.
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(file).pipe(res);
  });
}

// ---------------------------------------------------------------------------
// The join mailbox, /api/signal (see netlify/functions/signal.mts)
// ---------------------------------------------------------------------------

/** A room the host has not checked for this long is closed. */
const ROOM_TTL = 90 * 1000;
const CODE = /^[A-HJ-NP-Z2-9]{6}$/;
const PEER = /^[a-z0-9]{6,32}$/;
const mailbox = new Map();

function liveRoom(code) {
  const room = mailbox.get(code);
  if (!room) return null;
  if (Date.now() - room.seen > ROOM_TTL) {
    mailbox.delete(code);
    return null;
  }
  return room;
}

function signalReply(body) {
  const code = String(body.room ?? '');
  const peer = String(body.peer ?? '');
  const sdp = typeof body.sdp === 'string' && body.sdp.length < 20000 ? body.sdp : null;
  if (body.op === 'ping') return { ok: true };
  if (!CODE.test(code)) return { ok: false, error: 'code' };
  switch (body.op) {
    case 'open':
      if (liveRoom(code)) return { ok: false, error: 'taken' };
      mailbox.set(code, { seen: Date.now(), offers: new Map(), answers: new Map() });
      return { ok: true };
    case 'offer': {
      const room = liveRoom(code);
      if (!room) return { ok: false, error: 'noroom' };
      if (!PEER.test(peer) || !sdp) return { ok: false, error: 'bad' };
      room.offers.set(peer, sdp);
      return { ok: true };
    }
    case 'poll': {
      const room = mailbox.get(code);
      if (!room) return { ok: false, error: 'noroom' };
      room.seen = Date.now();
      const offers = [...room.offers].map(([p, s]) => ({ peer: p, sdp: s }));
      room.offers.clear();
      return { ok: true, offers };
    }
    case 'answer': {
      const room = mailbox.get(code);
      if (!room) return { ok: false, error: 'noroom' };
      if (!PEER.test(peer) || !sdp) return { ok: false, error: 'bad' };
      room.answers.set(peer, sdp);
      return { ok: true };
    }
    case 'await': {
      const room = liveRoom(code);
      if (!room) return { ok: false, error: 'noroom' };
      const answer = room.answers.get(peer) ?? null;
      if (answer) room.answers.delete(peer);
      return { ok: true, sdp: answer };
    }
    case 'close':
      mailbox.delete(code);
      return { ok: true };
  }
  return { ok: false, error: 'op' };
}

function serveSignal(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405).end();
    return;
  }
  let size = 0;
  const chunks = [];
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > 64 * 1024) req.destroy();
    else chunks.push(chunk);
  });
  req.on('end', () => {
    let reply;
    try {
      reply = signalReply(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch {
      reply = { ok: false, error: 'bad' };
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(reply));
  });
}

// ---------------------------------------------------------------------------
// WebSockets, by hand (RFC 6455, only what a browser sends)
// ---------------------------------------------------------------------------

/** The biggest message accepted: a large world on its way to a guest fits easily. */
const MAX_MESSAGE = 64 * 1024 * 1024;

class WebSocketConnection {
  constructor(tcp) {
    this.tcp = tcp;
    this.chunks = [];
    this.buffered = 0;
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.open = true;
    this.onmessage = null;
    this.onclose = null;
    tcp.setNoDelay(true);
    tcp.setKeepAlive(true, 30000);
    tcp.on('data', (data) => this._data(data));
    tcp.on('close', () => this._ended());
    tcp.on('error', () => this._ended());
  }

  _data(data) {
    this.chunks.push(data);
    this.buffered += data.length;
    for (;;) {
      if (this.buffered < 2) return;
      const buffer = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
      this.chunks = [buffer];
      const fin = (buffer[0] & 0x80) !== 0;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        if (buffer.readUInt32BE(2) !== 0) { this.close(1009); return; }
        length = buffer.readUInt32BE(6);
        offset = 10;
      }
      if (length > MAX_MESSAGE) { this.close(1009); return; }
      const maskAt = offset;
      if (masked) offset += 4;
      if (buffer.length < offset + length) return;

      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      if (masked) {
        for (let i = 0; i < payload.length; i++) payload[i] ^= buffer[maskAt + (i & 3)];
      }
      const rest = buffer.subarray(offset + length);
      this.chunks = rest.length > 0 ? [rest] : [];
      this.buffered = rest.length;
      this._frame(fin, opcode, payload);
      if (!this.open) return;
    }
  }

  _frame(fin, opcode, payload) {
    if (opcode === 0x8) { this.close(); return; }
    if (opcode === 0x9) { this._send(0xa, payload); return; }
    if (opcode === 0xa) return;
    if (opcode === 0x1 || opcode === 0x2) {
      this.fragmentOpcode = opcode;
      this.fragments = [payload];
    } else if (opcode === 0x0) {
      this.fragments.push(payload);
    } else {
      return;
    }
    if (!fin) return;
    const message = Buffer.concat(this.fragments);
    this.fragments = [];
    if (this.fragmentOpcode === 0x1 && this.onmessage) this.onmessage(message.toString('utf8'));
  }

  send(text) {
    this._send(0x1, Buffer.from(text, 'utf8'));
  }

  _send(opcode, payload) {
    if (!this.open) return;
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x80 | opcode, payload.length]);
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(payload.length, 6);
    }
    this.tcp.write(Buffer.concat([header, payload]));
  }

  close(code = 1000) {
    if (!this.open) return;
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code);
    this._send(0x8, payload);
    this.open = false;
    this.tcp.end();
    this._ended();
  }

  _ended() {
    if (this._done) return;
    this._done = true;
    this.open = false;
    if (this.onclose) this.onclose();
  }
}

// ---------------------------------------------------------------------------
// The relay, /mp
// ---------------------------------------------------------------------------
//
// The host's browser opens a room by its join code; each guest who connects
// with that code gets a number. To the host every message is framed
// "number|text" ("sys|{...}" for arrivals and departures), and it answers the
// same way, "*" meaning everyone. Guests just send and receive text.

const rooms = new Map();
const sys = (object) => `sys|${JSON.stringify(object)}`;

function relay(socket, role, code) {
  code = String(code ?? '').toUpperCase();
  if (!CODE.test(code)) {
    socket.close(1008);
    return;
  }

  if (role === 'host') {
    if (rooms.has(code)) {
      socket.send(sys({ sys: 'taken' }));
      socket.close();
      return;
    }
    const room = { host: socket, guests: new Map(), next: 1 };
    rooms.set(code, room);
    socket.send(sys({ sys: 'open', room: code }));
    console.log(`  [multiplayer] a world opened as ${code.slice(0, 3)}-${code.slice(3)}`);
    socket.onmessage = (text) => {
      const bar = text.indexOf('|');
      if (bar < 0) return;
      const to = text.slice(0, bar);
      const body = text.slice(bar + 1);
      if (to === 'sys') {
        try {
          const command = JSON.parse(body);
          if (command.close) room.guests.get(command.close)?.close();
        } catch {
          // Not a command we know.
        }
        return;
      }
      if (to === '*') {
        for (const guest of room.guests.values()) guest.send(body);
        return;
      }
      room.guests.get(Number(to))?.send(body);
    };
    socket.onclose = () => {
      rooms.delete(code);
      for (const guest of room.guests.values()) guest.close();
      room.guests.clear();
      console.log(`  [multiplayer] ${code.slice(0, 3)}-${code.slice(3)} closed`);
    };
    return;
  }

  if (role === 'guest') {
    const room = rooms.get(code);
    if (!room) {
      socket.send(JSON.stringify({ sys: 'noroom' }));
      socket.close();
      return;
    }
    const id = room.next++;
    room.guests.set(id, socket);
    socket.send(JSON.stringify({ sys: 'joined' }));
    room.host.send(sys({ sys: 'join', peer: id }));
    socket.onmessage = (text) => room.host.send(`${id}|${text}`);
    socket.onclose = () => {
      if (room.guests.delete(id)) room.host.send(sys({ sys: 'leave', peer: id }));
    };
    return;
  }

  socket.close(1008);
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

if (!(await portIsFree(port))) {
  console.error(`
  Port ${port} is already in use, so the server did not start.

  Something else is holding it — often a dev server left running from an
  earlier session. Find it and stop it:

    Get-Process -Id (Get-NetTCPConnection -LocalPort ${port} -State Listen).OwningProcess
    Stop-Process -Id <the PID printed above> -Force

  Or just use a different port:

    npm run host -- 5174

  Deliberately not falling back to a random port: that would break the link
  you already shared and would not match your firewall rule.
`);
  process.exit(1);
}

const addresses = lanAddresses();

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/api/signal') {
    serveSignal(req, res);
    return;
  }
  if (pathname === '/mp/info') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ relay: true, lan: addresses.map(({ address }) => `${address}:${port}`) }));
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  serveFile(req, res, pathname);
});

server.on('upgrade', (req, tcp, head) => {
  const url = new URL(req.url, 'http://localhost');
  const key = req.headers['sec-websocket-key'];
  if (url.pathname !== '/mp' || String(req.headers.upgrade).toLowerCase() !== 'websocket' || !key) {
    tcp.destroy();
    return;
  }
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  tcp.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  const socket = new WebSocketConnection(tcp);
  if (head && head.length > 0) socket._data(head);
  relay(socket, url.searchParams.get('role'), url.searchParams.get('room'));
});

// Bind explicitly to 0.0.0.0 so the server accepts connections from the network,
// not just from this machine.
server.listen(port, '0.0.0.0', () => {
  console.log(`
  Voxel Craft is running on port ${port}.

  SEND THIS to anyone who wants to play:`);

  if (addresses.length === 0) {
    console.log(`
    (No network address found — are you on Wi-Fi or Ethernet?)`);
  } else {
    for (const { name, address } of addresses) {
      console.log(`    http://${address}:${port}          [via ${name}]`);
    }
  }

  console.log(`
  For yourself, on this machine only:
    http://localhost:${port}

  To play together: open a world, pause, and press "Open to Friends". The
  pause menu shows a join code and a link for people on your network.

  Do NOT send a "localhost" link to anyone else. On their computer, localhost
  means *their* computer, so it will never reach this server.

  They must be on the same Wi-Fi / network as you.

  If they get a timeout, Windows Firewall is blocking the port. In an
  Administrator PowerShell, run this once:

    New-NetFirewallRule -DisplayName "Voxel Craft ${port}" -Direction Inbound -LocalPort ${port} -Protocol TCP -Action Allow -Profile Private

  Press Ctrl+C to stop the server.
`);
});
