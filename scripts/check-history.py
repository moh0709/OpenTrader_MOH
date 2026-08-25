import json, urllib.request

line = [l for l in open("/etc/opentrader/admin-password.env") if "ADMIN_PASSWORD" in l][0]
pw = line.split("=", 1)[1].strip().strip('"').strip("'")

def call(path, body=None):
    data = json.dumps(body or {}).encode() if body is not None else None
    req = urllib.request.Request(f"http://[::1]:8000{path}", headers={"Authorization": pw, "Content-Type": "application/json"}, data=data)
    return urllib.request.urlopen(req).read().decode()

print("journal:", call("/api/dash/learning?limit=5")[:300])
print("sweep:", call("/api/dash/actions/learning.evaluate", {}))
print("journal after:", call("/api/dash/learning?limit=5")[:400])
print("widget served:", "learningJournal" in urllib.request.urlopen("http://[::1]:8000/analytics/widgets/index.js").read().decode())
