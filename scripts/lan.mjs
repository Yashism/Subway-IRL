/**
 * Play on another device on the same Wi-Fi (a phone, a tablet, a second laptop).
 *
 *   npm run lan           serve the game over HTTPS on this machine's network address
 *   npm run lan:forward   WSL only: forward that port from Windows into WSL and open it (admin)
 *   npm run lan:stop      WSL only: remove the forward and the firewall rule again (admin)
 *
 * Why HTTPS: a browser only lets a page use the camera on https:// or on localhost, so the plain
 * http://<ip>:5173 would load the game with no webcam. The certificate is self-signed and made on
 * this machine, so each device shows a one-time "not private" warning to tap through.
 *
 * Why the forward: under WSL2's default NAT networking the dev server lives behind a private
 * address Windows can reach but the rest of the network cannot. Windows forwards the port to it
 * (`netsh interface portproxy`) and a firewall rule lets devices on the local subnet — and only
 * them, on only this port — through. The WSL address changes when WSL restarts, so after a reboot
 * run `npm run lan:forward` again; `npm run lan` warns when the forward has gone stale.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';

const PORT = 5174;
const RULE = 'Subway IRL (LAN play)';
const root = new URL('../', import.meta.url).pathname;
const certDir = join(root, '.cert');
const keyPath = join(certDir, 'lan-key.pem');
const certPath = join(certDir, 'lan-cert.pem');
const ipsPath = join(certDir, 'lan-ips.json');

const isWsl = (() => {
  try {
    return /microsoft/i.test(readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
})();

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...opts });

/** The addresses other devices on the network can reach this machine at. */
function lanAddresses() {
  if (isWsl) {
    // WSL's own addresses are private to this machine; the ones that matter are Windows'.
    const out = run('ipconfig.exe', []).replace(/\r/g, '');
    const ips = [];
    let adapter = '';
    for (const line of out.split('\n')) {
      if (/adapter .*:$/.test(line)) adapter = line;
      const m = line.match(/IPv4 Address[ .]*: ([\d.]+)/);
      // Skip WSL's and Hyper-V's own virtual switches and link-local addresses.
      if (m && !/vEthernet/i.test(adapter) && !m[1].startsWith('169.254.')) ips.push(m[1]);
    }
    return ips;
  }
  return Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.'))
    .map((i) => i.address);
}

function wslAddress() {
  const eth = networkInterfaces().eth0?.find((i) => i.family === 'IPv4');
  if (!eth) throw new Error('Could not find the WSL address (eth0).');
  return eth.address;
}

/** A self-signed certificate for these addresses, made again when they change or it nears expiry. */
function ensureCert(ips) {
  mkdirSync(certDir, { recursive: true });
  const wanted = JSON.stringify([...ips].sort());
  const current = existsSync(ipsPath) ? readFileSync(ipsPath, 'utf8') : '';
  let fresh = existsSync(certPath) && existsSync(keyPath) && current === wanted;
  if (fresh) {
    try {
      run('openssl', ['x509', '-checkend', String(7 * 86400), '-noout', '-in', certPath]);
    } catch {
      fresh = false;
    }
  }
  if (fresh) return;
  const san = ['DNS:localhost', 'IP:127.0.0.1', ...ips.map((ip) => `IP:${ip}`)].join(',');
  // 825 days, RSA 2048, SHA-256, serverAuth: the limits iOS and macOS place on a server certificate.
  run('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '825',
    '-keyout', keyPath, '-out', certPath,
    '-subj', '/CN=Subway IRL (this computer)',
    '-addext', `subjectAltName=${san}`,
    '-addext', 'basicConstraints=CA:FALSE',
    '-addext', 'keyUsage=digitalSignature,keyEncipherment',
    '-addext', 'extendedKeyUsage=serverAuth',
  ], { stdio: 'pipe' });
  writeFileSync(ipsPath, wanted);
  console.log(`Made a certificate for ${ips.join(', ')}.`);
}

/** WSL only: does Windows currently forward the port to this WSL instance? */
function forwardState() {
  const out = run('netsh.exe', ['interface', 'portproxy', 'show', 'v4tov4']).replace(/\r/g, '');
  const line = out.split('\n').find((l) => l.trim().startsWith('0.0.0.0') && l.includes(String(PORT)));
  if (!line) return 'missing';
  return line.includes(wslAddress()) ? 'ok' : 'stale';
}

/** WSL only: runs a PowerShell script elevated, which pops a Windows permission prompt. */
function runElevated(script) {
  const winTemp = run('cmd.exe', ['/c', 'echo %TEMP%'], { cwd: '/mnt/c' }).trim();
  const temp = run('wslpath', ['-u', winTemp]).trim();
  const file = join(temp, 'subway-irl-lan.ps1');
  const done = join(temp, 'subway-irl-lan.done');
  writeFileSync(file, script.replace('RESULT', `${winTemp}\\subway-irl-lan.done`));
  try {
    run('rm', ['-f', done]);
  } catch {
    /* nothing to clear */
  }
  console.log('Windows will ask for permission to change its network settings — choose Yes.');
  run('powershell.exe', [
    '-NoProfile', '-Command',
    `Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${winTemp}\\subway-irl-lan.ps1'`,
  ], { cwd: '/mnt/c', stdio: 'inherit' });
  return existsSync(done);
}

function forward() {
  if (!isWsl) {
    console.log('Not running under WSL: nothing to forward. `npm run lan` is all you need.');
    return;
  }
  const wsl = wslAddress();
  const ok = runElevated(`
netsh interface portproxy delete v4tov4 listenport=${PORT} listenaddress=0.0.0.0 | Out-Null
netsh interface portproxy add v4tov4 listenport=${PORT} listenaddress=0.0.0.0 connectport=${PORT} connectaddress=${wsl}
Get-NetFirewallRule -DisplayName '${RULE}' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName '${RULE}' -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${PORT} -Profile Any -RemoteAddress LocalSubnet | Out-Null
'ok' | Out-File -Encoding ascii 'RESULT'
`);
  if (!ok || forwardState() !== 'ok') {
    console.log('The forward was not set up (was the permission prompt declined?). Nothing was changed.');
    process.exitCode = 1;
    return;
  }
  console.log(`Windows now forwards port ${PORT} to WSL (${wsl}), and lets devices on your Wi-Fi reach it.`);
  console.log('Undo it any time with: npm run lan:stop');
}

function stop() {
  if (!isWsl) return;
  const ok = runElevated(`
netsh interface portproxy delete v4tov4 listenport=${PORT} listenaddress=0.0.0.0 | Out-Null
Get-NetFirewallRule -DisplayName '${RULE}' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
'ok' | Out-File -Encoding ascii 'RESULT'
`);
  console.log(ok ? 'Removed the forward and the firewall rule.' : 'Nothing was changed (was the prompt declined?).');
}

function serve() {
  const ips = lanAddresses();
  if (ips.length === 0) {
    console.error('This machine does not seem to be on a network. Connect to Wi-Fi and try again.');
    process.exit(1);
  }
  ensureCert(ips);
  if (isWsl) {
    const state = forwardState();
    if (state !== 'ok') {
      console.log(
        state === 'stale'
          ? `\n  ! WSL's address has changed since the forward was set up. Run: npm run lan:forward\n`
          : `\n  ! Other devices cannot reach WSL yet. In another terminal, run once: npm run lan:forward\n`,
      );
    }
  }
  console.log('\n  Play on another device on the same Wi-Fi:');
  for (const ip of ips) console.log(`    https://${ip}:${PORT}/`);
  console.log('\n  The first time, the browser warns the connection is not private: the certificate was');
  console.log('  made by this computer, not a public authority. Choose Advanced → Proceed (Chrome) or');
  console.log('  Show Details → visit this website (Safari). This laptop keeps using http://localhost:5173.\n');
  const vite = spawn(join(root, 'node_modules/.bin/vite'), ['--host', '0.0.0.0', '--port', String(PORT), '--strictPort'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, SUBWAY_LAN_CERT_DIR: certDir },
  });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => vite.kill(sig));
  vite.on('exit', (code) => process.exit(code ?? 0));
}

const cmd = process.argv[2] ?? 'serve';
if (cmd === 'serve') serve();
else if (cmd === 'forward') forward();
else if (cmd === 'stop') stop();
else {
  console.error(`Unknown command "${cmd}". Use serve, forward or stop.`);
  process.exit(2);
}
