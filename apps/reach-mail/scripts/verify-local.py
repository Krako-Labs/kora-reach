#!/usr/bin/env python3
"""Real, opt-in loopback SMTP->IMAP probe. Never tests external delivery."""
import email.message
import imaplib
import json
import smtplib
import ssl
import sys
import time
import uuid

try:
    request = json.loads(sys.stdin.read(8192))
    address = request['email']
    password = request['password']
    context = ssl.create_default_context(cafile=request['certificateFile'])
    message_id = '<reach-local-' + uuid.uuid4().hex + '@' + address.split('@')[1] + '>'
    message = email.message.EmailMessage()
    message['From'] = address
    message['To'] = address
    message['Subject'] = 'KORA Reach local delivery verification'
    message['Message-ID'] = message_id
    message.set_content('Synthetic local verification message. No external recipient.')
    with smtplib.SMTP('127.0.0.1', int(request['submissionPort']), timeout=15) as smtp:
        smtp.ehlo()
        smtp.starttls(context=context)
        smtp.ehlo()
        smtp.login(address, password)
        refused = smtp.send_message(message, from_addr=address, to_addrs=[address])
        if refused:
            raise RuntimeError('submission refused')
    received = False
    deadline = time.monotonic() + 25
    with imaplib.IMAP4_SSL('127.0.0.1', int(request['imapsPort']), ssl_context=context, timeout=15) as inbox:
        inbox.login(address, password)
        while time.monotonic() < deadline:
            inbox.select('INBOX', readonly=True)
            status, messages = inbox.search(None, 'HEADER', 'Message-ID', '"' + message_id + '"')
            if status == 'OK' and messages and messages[0].strip():
                received = True
                break
            time.sleep(1)
    if not received:
        raise RuntimeError('receipt was not confirmed')
    print(json.dumps({'smtpAccepted': True, 'imapReceived': True, 'messageId': message_id, 'syntheticMessageRetained': True}))
except Exception:
    # Raw protocol exceptions may include credentials or user data.
    print(json.dumps({'smtpAccepted': False, 'imapReceived': False, 'error': 'Local mail verification failed; inspect the local server state.'}))
    sys.exit(1)
