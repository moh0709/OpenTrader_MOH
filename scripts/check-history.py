import json, urllib.request, urllib.parse

line = [l for l in open("/etc/opentrader/admin-password.env") if "ADMIN_PASSWORD" in l][0]
pw = line.split("=", 1)[1].strip().strip('"').strip("'")

def trpc(name, body=None):
    if body is None:
        url = f"http://[::1]:8000/api/trpc/{name}?input=" + urllib.parse.quote('{"json":null}')
        req = urllib.request.Request(url, headers={"Authorization": pw})
    else:
        req = urllib.request.Request(
            f"http://[::1]:8000/api/trpc/{name}",
            headers={"Authorization": pw, "Content-Type": "application/json"},
            data=json.dumps({"json": body}).encode(),
        )
    return json.loads(urllib.request.urlopen(req).read().decode())

def call(path, body=None):
    data = json.dumps(body or {}).encode() if body is not None else None
    req = urllib.request.Request(f"http://[::1]:8000{path}", headers={"Authorization": pw, "Content-Type": "application/json"}, data=data)
    return urllib.request.urlopen(req).read().decode()

bots = trpc("bot.list").get("result", {}).get("data", {}).get("json", [])
for b in bots:
    print(b.get("id"), b.get("name"), b.get("symbol"), "enabled=" + str(b.get("enabled")))

import sys
for bot_id in sys.argv[1:]:
    try:
        trpc("bot.start", {"botId": int(bot_id)})
        print(f"started {bot_id}")
    except Exception as e:
        print(f"start {bot_id} failed: {e}")

bots = trpc("bot.list").get("result", {}).get("data", {}).get("json", [])
print("--- after ---")
for b in bots:
    print(b.get("id"), b.get("name"), "enabled=" + str(b.get("enabled")))

