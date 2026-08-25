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
print("models fetched:", len(models.get("models", [])), "| first:", models.get("models", [])[:3])

test = json.loads(call("/api/dash/actions/ai-settings.test", {"provider": "openrouter", "apiKey": orkey}))
print("connection test:", test)

save = json.loads(call("/api/dash/actions/ai-settings.save", {"provider": "openrouter", "model": "anthropic/claude-haiku-4.5", "apiKey": orkey}))
print("save:", save)

after = json.loads(call("/api/dash/ai-settings"))
print("after save:", after)




