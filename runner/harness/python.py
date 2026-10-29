# SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
# SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
# SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
# The Gitcha function harness for runtime "python". It runs inside the sandbox.
# A harness is the small wrapper that loads the user's function, calls it once,
# and sends back its answer on one marker line on stdout.
# usage: python3 python.py ENTRY REQUEST.json
# The entry module defines handler(request). The request is a dict with method,
# path, query, headers, body (str) and body_base64. The handler returns a str,
# a dict with status/headers/body, or any JSON value.
import base64, importlib.util, json, sys, traceback

MARK = "@@GITCHA-RESPONSE@@"


# Print the response, base64-encoded, on its own marker line.
def emit(res):
    sys.stdout.write("\n%s %s\n" % (MARK, base64.b64encode(json.dumps(res).encode()).decode()))
    sys.stdout.flush()


# Turn whatever the handler returned into status, headers and body.
# None becomes 204 (no content). Bytes are sent base64-encoded. Other values become JSON.
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


# Read the request file, load the entry module, and call its handler.
# If the handler fails, print the traceback and answer with a 500 error.
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
