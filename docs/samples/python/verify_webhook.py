"""Verify X-SubEtha-Signature on an incoming webhook (standard library only)."""
import hashlib
import hmac
import time


def verify_webhook(secret: str, header: str | None, raw_body: bytes, tolerance_s: int = 300) -> bool:
    parts = dict(kv.split("=", 1) for kv in (header or "").split(",") if "=" in kv)
    try:
        t = int(parts["t"])
    except (KeyError, ValueError):
        return False
    if abs(time.time() - t) > tolerance_s or "v1" not in parts:
        return False
    expected = hmac.new(secret.encode(), f"{t}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, parts["v1"])


# Flask:
#   @app.post("/hooks/subetha")
#   def hook():
#       if not verify_webhook(SECRET, request.headers.get("X-SubEtha-Signature"), request.get_data()):
#           abort(401)
#       msg = request.get_json()
#       print(msg["topic"], msg.get("message"))
#       return "ok"
