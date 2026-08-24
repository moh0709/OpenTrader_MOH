import json, urllib.request

line = [l for l in open("/etc/opentrader/admin-password.env") if "ADMIN_PASSWORD" in l][0]
pw = line.split("=", 1)[1].strip().strip('"').strip("'")

def get(path):
    req = urllib.request.Request(f"http://[::1]:8000{path}", headers={"Authorization": pw})
    return json.loads(urllib.request.urlopen(req).read().decode())

bots = get("/api/trpc/bot.list?input=%7B%22json%22%3Anull%7D")
rows = bots.get("result", {}).get("data", {}).get("json", [])
for b in rows:
    print(b.get("id"), b.get("name"), b.get("symbol"), "enabled=" + str(b.get("enabled")))
