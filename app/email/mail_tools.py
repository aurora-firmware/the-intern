import imaplib
import smtplib
import email
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.header import decode_header
import config

def _imap_connect():
    conn = imaplib.IMAP4_SSL(config.IMAP_HOST, config.IMAP_PORT)
    conn.login(config.EMAIL_USER, config.EMAIL_PASS)
    return conn

def get_unread_emails(folder="INBOX", limit=10):
    conn = _imap_connect()
    conn.select(folder)
    _, msg_ids = conn.search(None, "UNSEEN")
    ids = msg_ids[0].split()[-limit:]  # most recent N
    results = []
    for mid in ids:
        _, data = conn.fetch(mid, "(RFC822)")
        msg = email.message_from_bytes(data[0][1])
        results.append({
            "id": mid.decode(),
            "from": msg["from"],
            "subject": _decode_header(msg["subject"]),
            "date": msg["date"],
            "body": _extract_body(msg),
        })
    conn.logout()
    return results

def get_email_by_id(message_id, folder="INBOX"):
    conn = _imap_connect()
    conn.select(folder)
    _, data = conn.fetch(message_id, "(RFC822)")
    msg = email.message_from_bytes(data[0][1])
    conn.logout()
    return {
        "id": message_id,
        "from": msg["from"],
        "subject": _decode_header(msg["subject"]),
        "date": msg["date"],
        "body": _extract_body(msg),
    }

def send_email(to, subject, body, reply_to_message_id=None):
    msg = MIMEMultipart()
    msg["From"] = config.EMAIL_USER
    msg["To"] = to
    msg["Subject"] = subject
    if reply_to_message_id:
        msg["In-Reply-To"] = reply_to_message_id
        msg["References"] = reply_to_message_id
    msg.attach(MIMEText(body, "plain"))
    with smtplib.SMTP(config.SMTP_HOST, config.SMTP_PORT) as server:
        server.starttls()
        server.login(config.EMAIL_USER, config.EMAIL_PASS)
        server.sendmail(config.EMAIL_USER, to, msg.as_string())
    return {"status": "sent", "to": to, "subject": subject}

def mark_as_read(message_id, folder="INBOX"):
    conn = _imap_connect()
    conn.select(folder)
    conn.store(message_id, "+FLAGS", "\\Seen")
    conn.logout()

def search_emails(query, folder="INBOX"):
    """query: IMAP search string e.g. 'FROM "boss@example.com"'"""
    conn = _imap_connect()
    conn.select(folder)
    _, msg_ids = conn.search(None, query)
    ids = msg_ids[0].split()
    conn.logout()
    return [mid.decode() for mid in ids]

# --- helpers ---

def _decode_header(value):
    if not value:
        return ""
    decoded, enc = decode_header(value)[0]
    if isinstance(decoded, bytes):
        return decoded.decode(enc or "utf-8", errors="replace")
    return decoded

def _extract_body(msg):
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_type() == "text/plain":
                return part.get_payload(decode=True).decode("utf-8", errors="replace")
    else:
        return msg.get_payload(decode=True).decode("utf-8", errors="replace")
    return ""
