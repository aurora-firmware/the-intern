import anthropic
import json
import mail_tools
import config

client = anthropic.Anthropic(api_key=config.ANTHROPIC_API_KEY)

TOOLS = [
    {
        "name": "get_unread_emails",
        "description": "Fetch unread emails from the inbox",
        "input_schema": {
            "type": "object",
            "properties": {
                "limit": {"type": "integer", "description": "Max emails to fetch", "default": 10}
            }
        }
    },
    {
        "name": "get_email_by_id",
        "description": "Fetch full content of a specific email by ID",
        "input_schema": {
            "type": "object",
            "properties": {
                "message_id": {"type": "string"}
            },
            "required": ["message_id"]
        }
    },
    {
        "name": "send_email",
        "description": "Send an email",
        "input_schema": {
            "type": "object",
            "properties": {
                "to": {"type": "string"},
                "subject": {"type": "string"},
                "body": {"type": "string"},
                "reply_to_message_id": {"type": "string", "description": "Optional, for replies"}
            },
            "required": ["to", "subject", "body"]
        }
    },
    {
        "name": "search_emails",
        "description": "Search emails using IMAP query syntax",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "IMAP search string e.g. FROM \"someone@example.com\""}
            },
            "required": ["query"]
        }
    },
    {
        "name": "mark_as_read",
        "description": "Mark an email as read",
        "input_schema": {
            "type": "object",
            "properties": {
                "message_id": {"type": "string"}
            },
            "required": ["message_id"]
        }
    },
]

TOOL_MAP = {
    "get_unread_emails": lambda args: mail_tools.get_unread_emails(**args),
    "get_email_by_id":   lambda args: mail_tools.get_email_by_id(**args),
    "send_email":        lambda args: mail_tools.send_email(**args),
    "search_emails":     lambda args: mail_tools.search_emails(**args),
    "mark_as_read":      lambda args: mail_tools.mark_as_read(**args),
}

SYSTEM_PROMPT = """You are an email assistant. You help manage and respond to emails.
Always be concise and professional. Never send an email without confirming the content
unless explicitly told to proceed automatically."""

def run(user_message, auto=False):
    """
    auto=False: interactive, agent will ask before sending
    auto=True:  for triggered runs (e.g. reacting to incoming mail)
    """
    system = SYSTEM_PROMPT
    if auto:
        system += "\nYou are running in automatic mode. Proceed with actions without asking for confirmation."

    messages = [{"role": "user", "content": user_message}]

    while True:
        response = client.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=1000,
            system=system,
            tools=TOOLS,
            messages=messages,
        )

        # collect any text response
        for block in response.content:
            if block.type == "text":
                print(f"Agent: {block.text}")

        if response.stop_reason == "end_turn":
            break

        if response.stop_reason == "tool_use":
            # execute all tool calls
            tool_results = []
            for block in response.content:
                if block.type == "tool_use":
                    print(f"  [tool] {block.name}({block.input})")
                    result = TOOL_MAP[block.name](block.input)
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": json.dumps(result),
                    })

            # feed results back
            messages.append({"role": "assistant", "content": response.content})
            messages.append({"role": "user", "content": tool_results})
        else:
            break
