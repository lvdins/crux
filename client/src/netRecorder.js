// Crux network recorder. Injected at document start into every in-app
// browser page (and on demand into pages opened before it existed). Wraps
// fetch and XMLHttpRequest and keeps the last 500 calls in
// window.__qlNet; the Network panel polls changes with take(sinceVersion).
(() => {
  if (window.__qlNet) return;
  const log = [];
  let seq = 0;
  let version = 0;
  const page = Math.random().toString(36).slice(2, 10);
  const MAX_BODY = 6000;

  const preview = (body) => {
    if (body == null) return null;
    if (typeof body === "string") return body.slice(0, MAX_BODY);
    if (body instanceof URLSearchParams) return body.toString().slice(0, MAX_BODY);
    if (typeof FormData !== "undefined" && body instanceof FormData) {
      const parts = [];
      body.forEach((v, k) => parts.push(k + "=" + (typeof v === "string" ? v : "[file]")));
      return parts.join("&").slice(0, MAX_BODY);
    }
    if (body instanceof Blob) return "[blob " + body.size + " bytes]";
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return "[binary " + (body.byteLength || 0) + " bytes]";
    return "[" + Object.prototype.toString.call(body).slice(8, -1) + "]";
  };
  const touch = (e) => {
    e.v = ++version;
  };
  const add = (e) => {
    log.push(e);
    if (log.length > 500) log.splice(0, log.length - 500);
    touch(e);
    return e;
  };
  const abs = (u) => {
    try {
      return new URL(u, location.href).href;
    } catch {
      return String(u);
    }
  };

  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      const req = typeof Request !== "undefined" && input instanceof Request ? input : null;
      const e = add({
        id: ++seq,
        type: "fetch",
        method: String((init && init.method) || (req && req.method) || "GET").toUpperCase(),
        url: abs(req ? req.url : input),
        start: Date.now(),
        status: 0,
        ms: null,
        size: null,
        ctype: "",
        reqBody: preview(init && init.body),
        resBody: null,
        error: null,
      });
      const t0 = performance.now();
      return origFetch.apply(this, arguments).then(
        (res) => {
          e.status = res.status;
          e.ms = Math.round(performance.now() - t0);
          e.ctype = res.headers.get("content-type") || "";
          touch(e);
          if (!/image|video|audio|font|octet-stream/.test(e.ctype)) {
            res
              .clone()
              .text()
              .then((t) => {
                e.size = t.length;
                e.resBody = t.slice(0, MAX_BODY);
                touch(e);
              })
              .catch(() => {});
          }
          return res;
        },
        (err) => {
          e.status = -1;
          e.ms = Math.round(performance.now() - t0);
          e.error = String((err && err.message) || err);
          touch(e);
          throw err;
        },
      );
    };
  }

  const XHR = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (XHR) {
    const open = XHR.open;
    const send = XHR.send;
    XHR.open = function (method, url) {
      this.__ql = { method: String(method || "GET").toUpperCase(), url: abs(url) };
      return open.apply(this, arguments);
    };
    XHR.send = function (body) {
      const info = this.__ql || { method: "GET", url: "" };
      const e = add({
        id: ++seq,
        type: "xhr",
        method: info.method,
        url: info.url,
        start: Date.now(),
        status: 0,
        ms: null,
        size: null,
        ctype: "",
        reqBody: preview(body),
        resBody: null,
        error: null,
      });
      const t0 = performance.now();
      this.addEventListener("loadend", () => {
        e.status = this.status || (e.error ? -1 : 0);
        e.ms = Math.round(performance.now() - t0);
        e.ctype = this.getResponseHeader("content-type") || "";
        if (this.responseType === "" || this.responseType === "text") {
          e.size = (this.responseText || "").length;
          e.resBody = (this.responseText || "").slice(0, MAX_BODY);
        } else if (this.responseType === "json") {
          try {
            const t = JSON.stringify(this.response);
            e.size = t.length;
            e.resBody = t.slice(0, MAX_BODY);
          } catch {}
        }
        if (!this.status) e.status = -1;
        touch(e);
      });
      this.addEventListener("error", () => {
        e.error = "network error";
      });
      return send.apply(this, arguments);
    };
  }

  window.__qlNet = {
    page,
    take: (since) => JSON.stringify({ page, url: location.href, version, entries: log.filter((x) => x.v > since) }),
    clear: () => {
      log.length = 0;
    },
  };
})();
