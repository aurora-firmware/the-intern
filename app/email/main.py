import sys
import imaplib
import time
import agent
import config

def cli_mode():
    prompt = " ".join(sys.argv[2:]) if len(sys.argv) > 2 else input("Task: ")
    agent.run(prompt)

def watch_mode():
    """IMAP IDLE — react when new mail arrives"""
    print("Watching inbox for new mail...")
    conn = imaplib.IMAP4_SSL(config.IMAP_HOST, config.IMAP_PORT)
    conn.login(config.EMAIL_USER, config.EMAIL_PASS)
    conn.select("INBOX")
    while True:
        try:
            # IMAP IDLE: server pushes notification when new mail arrives
            conn.send(b"IDLE\r\n")
            conn.readline()  # OK
            conn.readline()  # exists/recent notification
            conn.send(b"DONE\r\n")
            conn.readline()
            print("New mail detected — running agent...")
            agent.run("Check unread emails and handle them appropriately.", auto=True)
        except Exception as e:
            print(f"IDLE error: {e}, reconnecting...")
            time.sleep(5)
            conn = imaplib.IMAP4_SSL(config.IMAP_HOST, config.IMAP_PORT)
            conn.login(config.EMAIL_USER, config.EMAIL_PASS)
            conn.select("INBOX")

if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "cli"
    if mode == "watch":
        watch_mode()
    else:
        cli_mode()
