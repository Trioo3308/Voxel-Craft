/**
 * host.mjs — Start the game server so other people on your network can play.
 *
 *   npm run host              (port 5173)
 *   npm run host -- 8080      (custom port)
 *
 * Why this exists rather than a plain `serve` command:
 *   - It refuses to start on a busy port instead of silently moving to a random
 *     one. A random port breaks the link you already sent and does not match
 *     your firewall rule.
 *   - It prints the LAN address, and makes clear that `localhost` links only
 *     ever work on this machine.
 */

import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

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

console.log(`
  Voxel Craft is starting on port ${port}.

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

  Do NOT send a "localhost" link to anyone else. On their computer, localhost
  means *their* computer, so it will never reach this server.

  They must be on the same Wi-Fi / network as you.

  If they get a timeout, Windows Firewall is blocking the port. In an
  Administrator PowerShell, run this once:

    New-NetFirewallRule -DisplayName "Voxel Craft ${port}" -Direction Inbound -LocalPort ${port} -Protocol TCP -Action Allow -Profile Private

  Press Ctrl+C to stop the server.
`);

// Bind explicitly to 0.0.0.0 so the server accepts connections from the network,
// not just from this machine.
// `npx` is a .cmd shim on Windows; naming it directly avoids `shell: true`,
// which would concatenate arguments unescaped.
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const child = spawn(
  npx,
  ['--yes', 'serve', '--no-port-switching', '-l', `tcp://0.0.0.0:${port}`, '.'],
  { stdio: 'inherit', cwd: projectRoot }
);

child.on('exit', (code) => process.exit(code ?? 0));
process.on('SIGINT', () => child.kill('SIGINT'));
