import json, urllib.request

line = [l for l in open("/etc/opentrader/admin-password.env") if "ADMIN_PASSWORD" in l][0]
pw = line.split("=", 1)[1].strip().strip('"').strip("'")
key_line = [l for l in open("/root/.hermes/.opentrader.env") if "OPENROUTER_API_KEY" in l][0]
orkey = key_line.split("=", 1)[1].strip()

def call(path, body=None):
    data = json.dumps(body or {}).encode() if body is not None else None
    req = urllib.request.Request(f"http://[::1]:8000{path}", headers={"Authorization": pw, "Content-Type": "application/json"}, data=data)
    return urllib.request.urlopen(req).read().decode()

settings = json.loads(call("/api/dash/ai-settings"))
print("saved settings:", settings)

models = json.loads(call("/api/dash/actions/ai-models", {"provider": "openrouter", "apiKey": orkey}))
rows = models.get("models", [])
assert rows and isinstance(rows[0], dict), "ai-models must return objects, not bare ids"
assert {"id", "name", "description", "free"} <= set(rows[0]), f"missing fields: {rows[0]}"
free = [m for m in rows if m["free"]]
print("models fetched:", len(rows), "| free:", len(free), "| reported free:", models.get("freeCount"))
print("first free:", [m["id"] for m in free[:3]])
assert len(free) == models.get("freeCount"), "freeCount disagrees with the rows"

test = json.loads(call("/api/dash/actions/ai-settings.test", {"provider": "openrouter", "apiKey": orkey}))
print("connection test:", test)

save = json.loads(call("/api/dash/actions/ai-settings.save", {"provider": "openrouter", "model": "anthropic/claude-haiku-4.5", "apiKey": orkey}))
print("save:", save)

after = json.loads(call("/api/dash/ai-settings"))
print("after save:", after)





# The AI action feed. Cursor is a sequence number and the session identifies the
# buffer, so a daemon restart must be reported rather than silently starving a
# client that is still holding the previous run's cursor.
feed = json.loads(call("/api/dash/ai/actions?since=0"))
print("ai actions:", len(feed.get("actions", [])), "| cursor:", feed.get("cursor"), "| session:", feed.get("session"))
assert "session" in feed and "cursor" in feed, "ai/actions must return a session and a cursor"
stale = json.loads(call("/api/dash/ai/actions?since=999999&session=not-this-one"))
assert stale.get("restarted") is True, "a foreign session must replay from the top"
