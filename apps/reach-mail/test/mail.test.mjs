import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { execute, IMAGE, MailError } from '../src/mail.mjs';

const cli = fileURLToPath(new URL('../bin/reach-mail.mjs', import.meta.url));
async function fixture(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'reach-mail-test-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'instance');
  await execute({ action: 'init', instanceDir: root, domain: 'example.com', hostname: 'mail.example.com' });
  return root;
}
const request = (action, instanceDir, extra = {}) => ({ action, instanceDir, ...extra });
async function fakeDocker(root, events) {
  return async (command, args, options) => {
    events.push({ command, args, options });
    if (args.includes('add')) {
      const email = args[args.indexOf('add') + 1];
      await fs.appendFile(path.join(root, 'config/postfix-accounts.cf'), email + '|TEST_ONLY_NOT_A_PASSWORD_HASH\n');
    }
    return { code: 0, stdout: args.includes('ps') ? JSON.stringify([{ Service: 'mailserver', State: 'running', Health: 'healthy', SecretEnvironment: 'MUST_NOT_RETURN' }]) : '', stderr: '' };
  };
}

test('plan is read-only, pins the image, and isolates the local-test ports', async t => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'reach-mail-plan-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const target = path.join(parent, 'missing');
  const plan = await execute({ action: 'plan', instanceDir: target, domain: 'example.com', hostname: 'mail.example.com' });
  assert.equal(plan.configuration.image, IMAGE);
  assert.match(plan.compose, /127\.0\.0\.1:1587:587/);
  assert.doesNotMatch(plan.compose, /privileged|docker\.sock|NET_ADMIN/);
  assert.equal(plan.network.deliveryVerified, false);
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
});

test('local-test initialization creates real TLS material and preserves an existing instance', async t => {
  const root = await fixture(t);
  assert.match(await fs.readFile(path.join(root, 'certs/fullchain.pem'), 'utf8'), /BEGIN CERTIFICATE/);
  assert.equal((await fs.stat(path.join(root, 'certs/privkey.pem'))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(root)).mode & 0o777, 0o700);
  const before = await fs.readFile(path.join(root, 'certs/privkey.pem'));
  const result = await execute({ action: 'init', instanceDir: root, domain: 'example.com', hostname: 'mail.example.com' });
  assert.equal(result.status, 'already_configured');
  assert.deepEqual(await fs.readFile(path.join(root, 'certs/privkey.pem')), before);
});

test('invalid hostname and public local-test bindings fail before any process runs', async () => {
  for (const extra of [{ hostname: 'mail.example.com;touch /tmp/x' }, { bindAddress: '0.0.0.0' }, { domain: 'bad\nname.com' }]) {
    await assert.rejects(execute({ action: 'plan', instanceDir: '/tmp/never-created-reach-mail', domain: 'example.com', hostname: 'mail.example.com', ...extra }, { run: () => { throw new Error('Must not run'); } }), MailError);
  }
});

test('direct and relay profiles require explicit TLS and distinguish inbound from outbound', async () => {
  await assert.rejects(execute({ action: 'plan', instanceDir: '/tmp/mail-plan', domain: 'example.com', hostname: 'mail.example.com', profile: 'direct' }), { code: 'TLS_REQUIRED' });
  const plan = await execute({ action: 'plan', instanceDir: '/tmp/mail-plan', domain: 'example.com', hostname: 'mail.example.com', profile: 'relay', relayHost: 'relay.example.net', tlsCertPath: '/tmp/cert.pem', tlsKeyPath: '/tmp/key.pem' });
  assert.ok(plan.network.requiredBeforeInternetMail.some(s => s.includes('inbound gateway')));
  assert.equal(plan.configuration.bindAddress, '127.0.0.1');
  assert.equal(plan.changed, false);
});

test('symlink instance and replaced managed files are rejected', async t => {
  const root = await fixture(t);
  const link = root + '-link';
  await fs.symlink(root, link);
  await assert.rejects(execute(request('status', link)), { code: 'SYMLINK_NOT_ALLOWED' });
  await fs.appendFile(path.join(root, 'compose.yaml'), '\n# unreviewed change\n');
  await assert.rejects(execute(request('status', root)), { code: 'CONFIG_CHANGED' });
});

test('a configured account is idempotent and does not change its credential', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'config/postfix-accounts.cf'), 'alex@example.com|TEST_HASH\n');
  const result = await execute(request('account-add', root, { email: 'alex@example.com', generatePassword: true }), { run: () => { throw new Error('Must not invoke Docker'); } });
  assert.equal(result.status, 'already_exists');
  assert.equal(result.passwordChanged, false);
  assert.deepEqual(await fs.readdir(path.join(root, 'secrets')), []);
});

test('missing Docker does not generate a credential or claim account creation', async t => {
  const root = await fixture(t);
  await assert.rejects(execute(request('account-add', root, { email: 'alex@example.com', generatePassword: true }), { platform: 'linux', run: async () => { throw new Error('No Docker'); } }), { code: 'DOCKER_UNAVAILABLE' });
  assert.deepEqual(await fs.readdir(path.join(root, 'secrets')), []);
});

test('official setup contract uses argv for address and stdin for password, then checks configuration', async t => {
  const root = await fixture(t), events = [];
  const result = await execute(request('account-add', root, { email: 'alex@example.com', generatePassword: true }), { platform: 'linux', run: await fakeDocker(root, events) });
  const secret = (await fs.readFile(result.credentialFile, 'utf8')).trim();
  const call = events.find(item => item.args.includes('add'));
  assert.ok(call.args.includes('-T'));
  assert.ok(call.args.includes('--entrypoint'));
  assert.equal(call.args.includes(secret), false);
  assert.equal(call.options.input, secret + '\n' + secret + '\n');
  assert.equal((await fs.stat(result.credentialFile)).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(result.configurationVerified, true);
  assert.equal(result.runtimeVerified, false);
  assert.equal(result.status, 'configured');
});

test('failed upstream commands with sensitive output return no command output', async t => {
  const root = await fixture(t);
  const run = async (_command, args, options) => args.includes('add') ? { code: 1, stdout: options.input, stderr: options.input } : { code: 0, stdout: '', stderr: '' };
  let failure;
  try { await execute(request('account-add', root, { email: 'alex@example.com', generatePassword: true }), { platform: 'linux', run }); } catch (error) { failure = error; }
  assert.equal(failure.code, 'COMMAND_FAILED');
  const secret = (await fs.readFile(failure.details.credentialFile, 'utf8')).trim();
  assert.equal(JSON.stringify({ message: failure.message, details: failure.details }).includes(secret), false);
  assert.match(failure.details.retry, /Check account-list/);
});

test('a successful command is not treated as account completion without configuration evidence', async t => {
  const root = await fixture(t);
  await assert.rejects(execute(request('account-add', root, { email: 'alex@example.com', generatePassword: true }), { platform: 'linux', run: async () => ({ code: 0, stdout: 'success', stderr: '' }) }), { code: 'ACCOUNT_NOT_CONFIRMED' });
});

test('parallel account work cannot enter a second mutation while a lock exists', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, '.accounts.lock'), '');
  await assert.rejects(execute(request('account-add', root, { email: 'alex@example.com', generatePassword: true })), { code: 'ACCOUNT_OPERATION_BUSY' });
});

test('invalid account and direct password fields are rejected without echoing values', async t => {
  const root = await fixture(t);
  for (const email of ['-bad@example.com', 'alex@example.com;id', 'Alex@example.com', 'alex@other.example', 'alex.@example.com']) await assert.rejects(execute(request('account-add', root, { email, generatePassword: true })), MailError);
  const secret = 'TEST-SECRET-DO-NOT-ECHO';
  const result = spawnSync(process.execPath, [cli, '--json-stdin'], { input: JSON.stringify(request('account-add', root, { email: 'alex@example.com', password: secret })), encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).error.code, 'UNKNOWN_FIELD');
  assert.equal((result.stdout + result.stderr).includes(secret), false);
});

test('status returns only sanitized runtime fields and never equates health with delivery', async t => {
  const root = await fixture(t), events = [];
  const result = await execute(request('status', root), { platform: 'linux', run: await fakeDocker(root, events) });
  assert.equal(result.configuration.valid, true);
  assert.equal(result.runtime.services[0].health, 'healthy');
  assert.equal(result.internetDeliveryVerified, false);
  assert.equal(JSON.stringify(result).includes('MUST_NOT_RETURN'), false);
});

test('start needs an account and stop preserves data by never requesting volume removal', async t => {
  const root = await fixture(t), events = [], run = await fakeDocker(root, events);
  await assert.rejects(execute(request('start', root), { platform: 'linux', run }), { code: 'ACCOUNT_REQUIRED' });
  await fs.writeFile(path.join(root, 'config/postfix-accounts.cf'), 'alex@example.com|TEST_HASH\n');
  const result = await execute(request('stop', root), { platform: 'linux', run });
  assert.equal(result.dataPreserved, true);
  const call = events.find(item => item.args.includes('down'));
  assert.equal(call.args.includes('--volumes'), false);
  assert.equal(call.args.includes('-v'), false);
});

test('local verification refuses other domains before any probe runs', async t => {
  const root = await fixture(t);
  await assert.rejects(execute(request('verify-local', root, { email: 'alex@external.example', passwordFile: '/tmp/no-password' }), { run: () => { throw new Error('Must not probe'); } }), { code: 'DOMAIN_MISMATCH' });
});

test('relay start rejects a directory or symlink in place of credential configuration', async t => {
  const source = await fixture(t);
  const root = path.join(path.dirname(source), 'relay-instance');
  await execute({ action: 'init', instanceDir: root, domain: 'example.com', hostname: 'mail.example.com', profile: 'relay', relayHost: 'relay.example.net', tlsCertPath: path.join(source, 'certs/fullchain.pem'), tlsKeyPath: path.join(source, 'certs/privkey.pem') });
  await fs.writeFile(path.join(root, 'config/postfix-accounts.cf'), 'alex@example.com|TEST_HASH\n');
  const credential = path.join(root, 'config/postfix-sasl-password.cf');
  const run = await fakeDocker(root, []);
  await fs.mkdir(credential);
  await assert.rejects(execute(request('start', root, { activateNetwork: true }), { platform: 'linux', run }), { code: 'RELAY_CREDENTIALS_REQUIRED' });
  await fs.rmdir(credential);
  await fs.symlink(path.join(source, 'certs/fullchain.pem'), credential);
  await assert.rejects(execute(request('start', root, { activateNetwork: true }), { platform: 'linux', run }), { code: 'SYMLINK_NOT_ALLOWED' });
});

test('the stdin interface emits one parseable JSON response for actual initialization', async t => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'reach-mail-cli-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [cli, '--json-stdin'], { input: JSON.stringify({ action: 'init', instanceDir: path.join(parent, 'mail'), domain: 'example.com', hostname: 'mail.example.com' }), encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.data.runtimeStarted, false);
});
