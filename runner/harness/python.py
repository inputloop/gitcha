# Gitcha function harness for runtime "python". Runs inside the sandbox.
# usage: python3 python.py ENTRY REQUEST.json
# The entry module defines handler(request); request is a dict with method,
# path, query, headers, body (str) and body_base64. Return a str, a dict with
# status/headers/body, or any JSON value.
import base64, importlib.util, json, sys, traceback

MARK = "@@GITCHA-RESPONSE@@"


def emit(res):
    sys.stdout.write("\n%s %s\n" % (MARK, base64.b64encode(json.dumps(res).encode()).decode()))
    sys.stdout.flush()


def to_response(out):
    if out is None:
        return {"status": 204, "headers": {}, "body": ""}
    if isinstance(out, str):
        return {"status": 200, "headers": {"content-type": "text/plain; charset=utf-8"}, "body": out}
    if isinstance(out, bytes):
        return {"status": 200, "headers": {"content-type": "application/octet-stream"}, "body": base64.b64encode(out).decode(), "bodyEncoding": "base64"}
    if isinstance(out, dict) and ("status" in out or "body" in out):
        body = out.get("body", "")
        headers = dict(out.get("headers") or {})
        if isinstance(body, bytes):
            return {"status": out.get("status", 200), "headers": headers, "body": base64.b64encode(body).decode(), "bodyEncoding": "base64"}
        if not isinstance(body, str):
            headers.setdefault("content-type", "application/json")
            body = json.dumps(body)
        return {"status": out.get("status", 200), "headers": headers, "body": body}
    return {"status": 200, "headers": {"content-type": "application/json"}, "body": json.dumps(out)}


def main():
    entry, req_file = sys.argv[1], sys.argv[2]
    with open(req_file) as f:
        raw = json.load(f)
    body = base64.b64decode(raw.get("body") or "")
    request = {
        "method": raw.get("method", "GET"), "path": raw.get("path", "/"), "query": raw.get("query") or {},
        "headers": raw.get("headers") or {}, "body": body.decode("utf-8", "replace"), "body_base64": raw.get("body") or "",
    }
    try:
        spec = importlib.util.spec_from_file_location("gitcha_fn", entry)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        emit(to_response(mod.handler(request)))
    except Exception as e:  # report, never hide, a failing handler
        traceback.print_exc()
        emit({"status": 500, "headers": {"content-type": "text/plain; charset=utf-8"}, "body": "The function threw an error.\n", "error": str(e)[:500]})
        sys.exit(1)


main()
