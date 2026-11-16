#!/usr/bin/env node
import { execute, MailError } from '../src/mail.mjs';

const help = {
  name: 'kora-reach-mail',
  version: '0.1.0-preview.1',
  usage: 'reach-mail --json-stdin',
  actions: ['plan', 'init', 'status', 'account-list', 'account-add', 'start', 'stop', 'dns-plan', 'verify-local'],
  example: { action: 'init', instanceDir: '/srv/reach-mail', domain: 'example.com', hostname: 'mail.example.com', profile: 'local-test' },
  credentials: 'Use passwordFile or generatePassword:true for account-add. Never include a password in the request.',
};

try {
  if (process.argv.length === 2 || process.argv.includes('--help')) {
    process.stdout.write(JSON.stringify({ ok: true, data: help }) + '\n');
  } else {
    if (process.argv.length !== 3 || process.argv[2] !== '--json-stdin') throw new MailError('INVALID_ARGUMENT', 'Use --json-stdin with one JSON request.');
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > 65536) throw new MailError('INPUT_TOO_LARGE', 'Request exceeds 64KiB.');
    }
    let request;
    try { request = JSON.parse(input); } catch { throw new MailError('INVALID_JSON', 'Expected one JSON request on stdin.'); }
    const data = await execute(request);
    process.stdout.write(JSON.stringify({ ok: true, data }) + '\n');
  }
} catch (error) {
  const safe = error instanceof MailError;
  process.stdout.write(JSON.stringify({ ok: false, error: {
    code: safe ? error.code : 'INTERNAL_ERROR',
    message: safe ? error.message : 'The mail operation failed. No command output or secret values were returned.',
    ...(safe && error.details ? { details: error.details } : {}),
  } }) + '\n');
  process.exitCode = 1;
}
