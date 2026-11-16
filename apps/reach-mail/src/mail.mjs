import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const IMAGE = 'ghcr.io/docker-mailserver/docker-mailserver:17.0.0';
export const CONTRACT_VERSION = 1;
const manifestName = 'reach-mail.json';
const actions = new Set(['plan', 'init', 'status', 'account-list', 'account-add', 'start', 'stop', 'dns-plan', 'verify-local']);
const allowedFields = new Set(['action', 'instanceDir', 'domain', 'hostname', 'profile', 'bindAddress', 'relayHost', 'relayPort', 'tlsCertPath', 'tlsKeyPath', 'email', 'passwordFile', 'generatePassword', 'activateNetwork']);
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

export class MailError extends Error {
  constructor(code, message, details) { super(message); this.code = code; this.details = details; }
}
function requireCondition(condition, code, message, details) { if (!condition) throw new MailError(code, message, details); }
function validDomain(value) {
  return typeof value === 'string' && value.length <= 253 && value === value.toLowerCase() && value.split('.').length >= 2
    && value.split('.').every(part => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(part));
}
function validateEmail(email, domain) {
  requireCondition(typeof email === 'string' && email.length <= 254 && /^[a-z0-9][a-z0-9._+-]{0,63}@[a-z0-9.-]+$/.test(email), 'INVALID_EMAIL', 'Use a lowercase email address with a simple local part.');
  requireCondition(email.split('@')[1] === domain, 'DOMAIN_MISMATCH', 'The address must belong to this instance domain.');
  requireCondition(!email.split('@')[0].includes('..') && !email.split('@')[0].endsWith('.'), 'INVALID_EMAIL', 'Consecutive dots and a trailing dot are not supported.');
  return email;
}
function validateRoot(value) {
  requireCondition(typeof value === 'string' && path.isAbsolute(value) && !/[\0\r\n]/.test(value), 'INVALID_DIRECTORY', 'instanceDir must be an absolute local path.');
  const resolved = path.resolve(value);
  requireCondition(resolved !== path.parse(resolved).root, 'INVALID_DIRECTORY', 'The filesystem root is not an instance directory.');
  return resolved;
}
async function safeStat(filename) { try { return await fs.lstat(filename); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
async function noSymlink(filename) {
  const stat = await safeStat(filename);
  requireCondition(!stat?.isSymbolicLink(), 'SYMLINK_NOT_ALLOWED', 'Instance state must not be a symbolic link.');
  return stat;
}
function normalize(request) {
  const profile = request.profile ?? 'local-test';
  requireCondition(['local-test', 'direct', 'relay'].includes(profile), 'INVALID_PROFILE', 'Choose local-test, direct, or relay.');
  requireCondition(validDomain(request.domain), 'INVALID_DOMAIN', 'domain must be a lowercase DNS name.');
  requireCondition(validDomain(request.hostname) && request.hostname !== request.domain && request.hostname.endsWith('.' + request.domain), 'INVALID_HOSTNAME', 'hostname must be a host below the mail domain, such as mail.example.com.');
  const bindAddress = request.bindAddress ?? '127.0.0.1';
  requireCondition(/^(?:\d{1,3}\.){3}\d{1,3}$/.test(bindAddress) && bindAddress.split('.').every(x => +x <= 255), 'INVALID_BIND_ADDRESS', 'Use an explicit IPv4 bind address.');
  requireCondition(profile !== 'local-test' || bindAddress === '127.0.0.1', 'LOCAL_BIND_REQUIRED', 'local-test only binds to 127.0.0.1.');
  const relayHost = request.relayHost ?? null;
  const relayPort = request.relayPort ?? 587;
  if (profile === 'relay') {
    requireCondition(validDomain(relayHost), 'RELAY_REQUIRED', 'relay requires a relayHost DNS name.');
    requireCondition(Number.isInteger(relayPort) && relayPort >= 1 && relayPort <= 65535, 'INVALID_PORT', 'relayPort is invalid.');
  } else requireCondition(relayHost === null, 'INVALID_RELAY', 'relayHost is only used with the relay profile.');
  if (profile !== 'local-test') requireCondition(typeof request.tlsCertPath === 'string' && typeof request.tlsKeyPath === 'string' && path.isAbsolute(request.tlsCertPath) && path.isAbsolute(request.tlsKeyPath), 'TLS_REQUIRED', 'direct and relay require absolute tlsCertPath and tlsKeyPath.');
  return {
    contractVersion: CONTRACT_VERSION, image: IMAGE, domain: request.domain, hostname: request.hostname,
    profile, bindAddress, relayHost: profile === 'relay' ? relayHost : null, relayPort: profile === 'relay' ? relayPort : null,
    ports: profile === 'local-test' ? { smtp: 1025, submission: 1587, smtps: 1465, imaps: 1993 } : { smtp: 25, submission: 587, smtps: 465, imaps: 993 },
  };
}
export function renderCompose(config, root) {
  const quote = JSON.stringify;
  const projectName = 'reach-mail-' + sha256(root).slice(0, 12);
  return `name: ${projectName}\nservices:\n  mailserver:\n    image: ${quote(config.image)}\n    hostname: ${quote(config.hostname)}\n    env_file: ./mailserver.env\n    ports:\n${Object.entries({ smtp: 25, submission: 587, smtps: 465, imaps: 993 }).map(([name, target]) => `      - ${quote(`${config.bindAddress}:${config.ports[name]}:${target}`)}`).join('\n')}\n    volumes:\n      - ./data/mail:/var/mail\n      - ./data/state:/var/mail-state\n      - ./data/logs:/var/log/mail\n      - ./config:/tmp/docker-mailserver\n      - ./certs:/tmp/dms-custom-certs:ro\n    restart: unless-stopped\n    stop_grace_period: 1m\n`;
}
export function renderEnvironment(config) {
  const lines = ['TZ=Etc/UTC', 'ACCOUNT_PROVISIONER=FILE', 'SSL_TYPE=manual', 'SSL_CERT_PATH=/tmp/dms-custom-certs/fullchain.pem', 'SSL_KEY_PATH=/tmp/dms-custom-certs/privkey.pem', 'ENABLE_CLAMAV=0', 'ENABLE_FAIL2BAN=0', 'ENABLE_RSPAMD=1', 'ENABLE_AMAVIS=0', 'ENABLE_SPAMASSASSIN=0', 'ENABLE_POSTGREY=0', 'PERMIT_DOCKER=none', 'SPOOF_PROTECTION=1', 'LOG_LEVEL=info'];
  if (config.profile === 'relay') lines.push(`DEFAULT_RELAY_HOST=[${config.relayHost}]:${config.relayPort}`);
  return lines.join('\n') + '\n';
}
export async function runCommand(command, args, { cwd, input = '', timeoutMs = 120000 } = {}) {
  return await new Promise((resolve, reject) => {
    let stdout = '', stderr = '', bytes = 0, settled = false, timedOut = false, overflow = false;
    const child = spawn(command, args, { cwd, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, COMPOSE_ANSI: 'never', COMPOSE_PROGRESS: 'quiet' } });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    const append = (which, chunk) => {
      bytes += chunk.length;
      if (bytes > 1048576) { overflow = true; child.kill('SIGKILL'); return; }
      if (which === 'out') stdout += chunk; else stderr += chunk;
    };
    child.stdout.on('data', chunk => append('out', chunk));
    child.stderr.on('data', chunk => append('err', chunk));
    child.stdin.on('error', () => {});
    child.once('error', error => {
      if (settled) return; settled = true; clearTimeout(timer);
      reject(new MailError(error.code === 'ENOENT' ? 'DEPENDENCY_MISSING' : 'PROCESS_ERROR', `${command} could not be started.`));
    });
    child.once('close', code => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (timedOut || overflow) reject(new MailError('COMMAND_INTERRUPTED', 'The operation was interrupted; inspect current state before retrying.'));
      else resolve({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}
async function checked(run, command, args, options) {
  const result = await run(command, args, options);
  requireCondition(result.code === 0, 'COMMAND_FAILED', `${command} did not complete successfully. Its output is withheld to avoid disclosing credentials.`, { exitCode: result.code });
  return result;
}
function composeArgs(root, ...args) { return ['compose', '--project-directory', root, '-f', path.join(root, 'compose.yaml'), ...args]; }
async function dockerAvailable(run, root, platform) {
  requireCondition(platform === 'linux', 'LINUX_REQUIRED', 'Mail container operations are supported on a Linux host.');
  try { await checked(run, 'docker', ['compose', 'version', '--short'], { cwd: root, timeoutMs: 15000 }); await checked(run, 'docker', ['info', '--format', '{{.ServerVersion}}'], { cwd: root, timeoutMs: 15000 }); }
  catch (error) { throw new MailError('DOCKER_UNAVAILABLE', 'A working Docker Engine and Docker Compose are required. Nothing was installed or started.'); }
}
async function readConfig(root) {
  const st = await noSymlink(root);
  requireCondition(st?.isDirectory(), 'NOT_CONFIGURED', 'Initialize this instance first.');
  await noSymlink(path.join(root, manifestName));
  let config;
  try { config = JSON.parse(await fs.readFile(path.join(root, manifestName), 'utf8')); } catch { throw new MailError('NOT_CONFIGURED', 'A valid reach-mail.json is required.'); }
  requireCondition(config.contractVersion === CONTRACT_VERSION && config.image === IMAGE, 'UNSUPPORTED_CONFIG', 'Unsupported mail instance version or image.');
  normalize({ ...config, tlsCertPath: path.join(root, 'certs/fullchain.pem'), tlsKeyPath: path.join(root, 'certs/privkey.pem') });
  for (const [filename, expected] of Object.entries(config.files ?? {})) {
    requireCondition(['compose.yaml', 'mailserver.env'].includes(filename), 'INVALID_CONFIG', 'Unexpected managed file.');
    await noSymlink(path.join(root, filename));
    const actual = sha256(await fs.readFile(path.join(root, filename)));
    requireCondition(actual === expected, 'CONFIG_CHANGED', 'Managed configuration changed after initialization. Review it before executing mail operations.');
  }
  requireCondition(Object.keys(config.files ?? {}).length === 2, 'INVALID_CONFIG', 'Managed configuration hashes are missing.');
  for (const name of ['config', 'secrets', 'certs', 'data', 'data/mail', 'data/state', 'data/logs']) await noSymlink(path.join(root, name));
  return config;
}
async function accounts(root) {
  const file = path.join(root, 'config/postfix-accounts.cf');
  await noSymlink(file);
  let content;
  try { content = await fs.readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return content.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#')).map(line => line.split('|')[0]).sort();
}
async function protectedPassword(filename) {
  requireCondition(typeof filename === 'string' && path.isAbsolute(filename), 'INVALID_PASSWORD_FILE', 'passwordFile must be an absolute path.');
  const stat = await noSymlink(filename);
  requireCondition(stat?.isFile() && stat.size <= 4096 && (stat.mode & 0o077) === 0, 'PASSWORD_FILE_PERMISSIONS', 'The password file must be a small regular file readable only by its owner.');
  const value = (await fs.readFile(filename, 'utf8')).replace(/\r?\n$/, '');
  requireCondition(value.length >= 16 && value.length <= 1024 && value === value.trim() && !/[\r\n\0]/.test(value), 'INVALID_PASSWORD', 'Use a single-line password between 16 and 1024 characters, without surrounding whitespace.');
  return value;
}
async function withAccountLock(root, operation) {
  const filename = path.join(root, '.accounts.lock');
  let handle;
  try { handle = await fs.open(filename, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') throw new MailError('ACCOUNT_OPERATION_BUSY', 'Another account operation is in progress. Inspect its outcome before retrying.'); throw error; }
  try { return await operation(); } finally { await handle.close(); await fs.unlink(filename); }
}
async function initialize(root, request, run) {
  const config = normalize(request);
  const existing = await noSymlink(root);
  if (existing?.isDirectory() && (await fs.readdir(root)).length > 0) {
    const current = await readConfig(root);
    requireCondition(JSON.stringify(normalize({ ...current, tlsCertPath: request.tlsCertPath, tlsKeyPath: request.tlsKeyPath })) === JSON.stringify(config), 'INSTANCE_EXISTS', 'This directory is already initialized with different settings.');
    return { status: 'already_configured', instanceDir: root, profile: current.profile, runtimeStarted: false };
  }
  requireCondition(!existing || existing.isDirectory(), 'INSTANCE_EXISTS', 'The instance path is already in use.');
  await fs.mkdir(path.dirname(root), { recursive: true });
  const temp = await fs.mkdtemp(path.join(path.dirname(root), '.' + path.basename(root) + '.setup-'));
  await fs.chmod(temp, 0o700);
  try {
    for (const name of ['config', 'secrets', 'certs', 'data/mail', 'data/state', 'data/logs']) await fs.mkdir(path.join(temp, name), { recursive: true, mode: 0o700 });
    if (config.profile === 'local-test') {
      await checked(run, 'openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '7', '-keyout', path.join(temp, 'certs/privkey.pem'), '-out', path.join(temp, 'certs/fullchain.pem'), '-subj', '/CN=' + config.hostname, '-addext', `subjectAltName=DNS:${config.hostname},IP:127.0.0.1`], { cwd: temp, timeoutMs: 30000 });
    } else {
      const certificate = await fs.readFile(request.tlsCertPath);
      const privateKey = await fs.readFile(request.tlsKeyPath);
      let cert, key;
      try { cert = new crypto.X509Certificate(certificate); key = crypto.createPrivateKey(privateKey); } catch { throw new MailError('INVALID_TLS', 'A readable PEM certificate and unencrypted PEM private key are required.'); }
      requireCondition(cert.checkPrivateKey(key) && cert.checkHost(config.hostname) && new Date(cert.validFrom).getTime() <= Date.now() && new Date(cert.validTo).getTime() > Date.now(), 'INVALID_TLS', 'The certificate must match the private key and hostname and be valid at the current time.');
      await fs.writeFile(path.join(temp, 'certs/fullchain.pem'), certificate, { mode: 0o644 });
      await fs.writeFile(path.join(temp, 'certs/privkey.pem'), privateKey, { mode: 0o600 });
    }
    await fs.chmod(path.join(temp, 'certs/privkey.pem'), 0o600);
    const compose = renderCompose(config, root), environment = renderEnvironment(config);
    await fs.writeFile(path.join(temp, 'compose.yaml'), compose, { mode: 0o600 });
    await fs.writeFile(path.join(temp, 'mailserver.env'), environment, { mode: 0o600 });
    config.files = { 'compose.yaml': sha256(compose), 'mailserver.env': sha256(environment) };
    await fs.writeFile(path.join(temp, manifestName), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    await fs.rename(temp, root);
    return { status: 'configured', instanceDir: root, profile: config.profile, image: config.image, bindAddress: config.bindAddress, runtimeStarted: false, localCertificateExpiresInDays: config.profile === 'local-test' ? 7 : undefined, next: 'Create an account before starting the container.' };
  } catch (error) { await fs.rm(temp, { recursive: true, force: true }); throw error; }
}
async function runtimeStatus(root, config, run, platform) {
  try {
    await dockerAvailable(run, root, platform);
    const result = await checked(run, 'docker', composeArgs(root, 'ps', '--all', '--format', 'json'), { cwd: root, timeoutMs: 20000 });
    let parsed;
    try { parsed = JSON.parse(result.stdout || '[]'); } catch { parsed = result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
    if (!Array.isArray(parsed)) parsed = [parsed];
    return { available: true, services: parsed.map(item => ({ service: item.Service, state: item.State, health: item.Health ?? null, exitCode: item.ExitCode ?? null })), checked: true };
  } catch (error) { return { available: false, checked: false, reason: error instanceof MailError ? error.code : 'STATUS_UNREADABLE' }; }
}
function dnsPlan(config) {
  return {
    applied: false,
    records: [{ type: 'MX', name: config.domain, priority: 10, value: config.hostname }, { type: 'TXT', name: '_dmarc.' + config.domain, value: 'v=DMARC1; p=none' }],
    requiredBeforeInternetMail: [
      'A/AAAA for the actual reachable mail endpoint; do not publish an unreachable IPv6 address.',
      'DKIM public key from the running server, and SPF matching the actual outbound delivery provider.',
      ...(config.profile === 'relay' ? ['Authenticated outbound relay credentials.', 'A reachable inbound SMTP endpoint or a separately configured inbound gateway; an outbound relay does not solve CGNAT.'] : ['Reachable inbound TCP25, permitted outbound TCP25, and suitable PTR/IP reputation for direct delivery.']),
      'Valid TLS certificates, external receipt tests, and recipient-provider delivery checks.',
    ],
    dynamicIp: 'DDNS only updates name resolution. It does not remove CGNAT, open TCP25, configure PTR, or establish IP reputation.',
    deliveryVerified: false,
  };
}
export async function execute(request, { run = runCommand, platform = process.platform } = {}) {
  requireCondition(request && typeof request === 'object' && !Array.isArray(request), 'INVALID_REQUEST', 'Expected a JSON object.');
  for (const key of Object.keys(request)) requireCondition(allowedFields.has(key), 'UNKNOWN_FIELD', 'The request contains an unsupported field.');
  requireCondition(actions.has(request.action), 'INVALID_ACTION', 'Unsupported mail action.');
  const root = validateRoot(request.instanceDir);
  if (request.action === 'plan') {
    const config = normalize(request);
    return { status: 'planned', instanceDir: root, configuration: config, compose: renderCompose(config, root), network: dnsPlan(config), changed: false };
  }
  if (request.action === 'init') return await initialize(root, request, run);
  const config = await readConfig(root);
  if (request.action === 'dns-plan') return dnsPlan(config);
  if (request.action === 'account-list') return { accounts: await accounts(root), evidence: 'DMS account configuration only', runtimeVerified: false };
  if (request.action === 'status') return { configuration: { valid: true, profile: config.profile, domain: config.domain, hostname: config.hostname, image: config.image, accountCount: (await accounts(root)).length }, runtime: await runtimeStatus(root, config, run, platform), internetDeliveryVerified: false };
  if (request.action === 'account-add') {
    const email = validateEmail(request.email, config.domain);
    return await withAccountLock(root, async () => {
      if ((await accounts(root)).includes(email)) return { status: 'already_exists', email, changed: false, passwordChanged: false, configurationVerified: true, runtimeVerified: false };
      requireCondition(Boolean(request.passwordFile) !== Boolean(request.generatePassword), 'CREDENTIAL_REQUIRED', 'Choose passwordFile or generatePassword:true.');
      requireCondition(request.generatePassword === undefined || request.generatePassword === true, 'INVALID_CREDENTIAL_MODE', 'generatePassword must be true when supplied.');
      await dockerAvailable(run, root, platform);
      let secret, credentialFile;
      if (request.generatePassword) {
        secret = crypto.randomBytes(24).toString('base64url');
        credentialFile = path.join(root, 'secrets', email + '.' + crypto.randomUUID() + '.password');
        await fs.writeFile(credentialFile, secret + '\n', { flag: 'wx', mode: 0o600 });
      } else { credentialFile = request.passwordFile; secret = await protectedPassword(credentialFile); }
      try {
        await checked(run, 'docker', composeArgs(root, 'run', '--rm', '--no-deps', '-T', '--entrypoint', 'setup', 'mailserver', 'email', 'add', email, ''), { cwd: root, input: secret + '\n' + secret + '\n', timeoutMs: 120000 });
        requireCondition((await accounts(root)).includes(email), 'ACCOUNT_NOT_CONFIRMED', 'The command returned, but the account configuration could not be confirmed. Inspect current state before retrying.', { email, credentialFile });
      } catch (error) {
        if (error instanceof MailError) error.details = { ...(error.details ?? {}), email, credentialFile, retry: 'Check account-list before retrying; do not rotate a possibly created account.' };
        throw error;
      } finally { secret = undefined; }
      return { status: 'configured', email, changed: true, configurationVerified: true, runtimeVerified: false, credentialFile, credentialHandling: 'Local owner-only file. Deliver through an approved private channel; do not read it into chat.', next: 'Start the server and verify account access. Configured does not mean Internet delivery is verified.' };
    });
  }
  if (request.action === 'start' || request.action === 'stop') {
    await dockerAvailable(run, root, platform);
    if (request.action === 'start') {
      requireCondition((await accounts(root)).length > 0, 'ACCOUNT_REQUIRED', 'Create at least one account before starting DMS.');
      requireCondition(config.profile === 'local-test' || request.activateNetwork === true, 'NETWORK_ACTIVATION_REQUIRED', 'Production start requires activateNetwork:true after reviewing the domain, TLS, inbound path and outbound delivery route.');
      if (config.profile === 'relay') {
        const relayFile = await noSymlink(path.join(root, 'config/postfix-sasl-password.cf'));
        requireCondition(relayFile?.isFile() && relayFile.size > 0, 'RELAY_CREDENTIALS_REQUIRED', 'Configure relay credentials in a regular nonempty file with the upstream DMS setup relay command before activating this profile.');
      }
    }
    await checked(run, 'docker', composeArgs(root, ...(request.action === 'start' ? ['up', '-d'] : ['down'])), { cwd: root, timeoutMs: 120000 });
    return { status: request.action === 'start' ? 'start_requested' : 'stopped', dataPreserved: true, runtime: await runtimeStatus(root, config, run, platform), internetDeliveryVerified: false };
  }
  if (request.action === 'verify-local') {
    requireCondition(config.profile === 'local-test' && config.bindAddress === '127.0.0.1', 'LOCAL_TEST_ONLY', 'verify-local only uses a local-test instance on loopback.');
    const email = validateEmail(request.email, config.domain);
    requireCondition((await accounts(root)).includes(email), 'ACCOUNT_MISSING', 'The local test account must already exist.');
    const password = await protectedPassword(request.passwordFile);
    const script = fileURLToPath(new URL('../scripts/verify-local.py', import.meta.url));
    const result = await checked(run, 'python3', [script], { cwd: root, input: JSON.stringify({ email, password, submissionPort: config.ports.submission, imapsPort: config.ports.imaps, certificateFile: path.join(root, 'certs/fullchain.pem') }), timeoutMs: 60000 });
    let evidence;
    try { evidence = JSON.parse(result.stdout); } catch { throw new MailError('INVALID_VERIFICATION', 'The local mail probe returned no valid evidence.'); }
    requireCondition(evidence.smtpAccepted === true && evidence.imapReceived === true, 'VERIFICATION_FAILED', 'The local delivery probe did not confirm receipt.');
    return { ...evidence, scope: 'loopback SMTP submission to the same local account, then IMAP read', internetDeliveryVerified: false };
  }
}
