// Crux network recorder. Injected at document start into every in-app
// browser page (and on demand into pages opened before it existed). Wraps
// fetch and XMLHttpRequest and keeps the last 500 calls in
// window.__qlNet; the Network panel polls changes with take(sinceVersion).
//
// Write guard: when window.__qlGuard (set by the guard_set command) is on,
// non-GET requests to guarded hosts that no granted write class covers are
// answered here with the chosen reply instead of reaching the server; the
// same applies to sendBeacon and form posts. decide() must match
// server/src/guard.ts. WebSocket messages and service-worker requests
// can't be stopped from here.
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

  /* ---------- write guard ---------- */
  const SAFE = { GET: 1, HEAD: 1, OPTIONS: 1 };
  const hostIs = (host, h) => {
    const bare = h.replace(/^\*\./, "");
    return host === bare || host.endsWith("." + bare);
  };
  const globRe = (glob) => new RegExp("^" + glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*"));
  const hits = (r, host, url, pathname, body) => {
    if (r.key === "entities") return !!r.prefix && (url.includes(r.prefix) || body.includes(r.prefix));
    const hosts = r.hosts || [];
    const paths = r.paths || [];
    if (!hosts.length && !paths.length) return false;
    return (!hosts.length || hosts.some((h) => hostIs(host, h))) && (!paths.length || paths.some((p) => globRe(p).test(pathname)));
  };
  const decide = (g, method, url, body) => {
    if (SAFE[method]) return { act: "pass" };
    let u;
    try {
      u = new URL(url);
    } catch {
      return { act: "pass" };
    }
    const host = u.hostname.toLowerCase();
    const matched = (g.rules || []).filter((r) => hits(r, host, url, u.pathname, body || ""));
    const prod = matched.find((r) => r.key === "production");
    if (!prod && !(g.hosts || []).some((h) => h && host.includes(String(h).toLowerCase()))) return { act: "pass" };
    // A refusal wins over a grant.
    const pick = prod || matched.find((r) => r.mode === "block") || matched.find((r) => r.mode === "ask") || matched.find((r) => r.mode === "allow");
    if (!pick) return { act: "block", cls: "unclassified" };
    const act = pick.key === "production" ? "block" : pick.mode;
    return { act, cls: pick.cls, grant: act === "allow" ? pick.grant : undefined };
  };
  /** Marks the entry and returns pass / allow / ask / block. */
  const judge = (e) => {
    const g = window.__qlGuard;
    if (!g || !g.on) return "pass";
    const d = decide(g, e.method, e.url, e.reqBody);
    if (d.act === "pass") return "pass";
    e.guarded = true;
    e.blocked = d.act === "block";
    e.class = d.cls || null;
    e.grant = d.grant || null;
    return d.act;
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  /** The chosen reply: 2xx echoes the request body as JSON, else an error body. */
  const reply = (e) => {
    const r = (window.__qlGuard && window.__qlGuard.reply) || {};
    const status = r.status >= 200 && r.status <= 599 && r.status !== 204 ? r.status : 200;
    let body;
    if (status < 300) {
      try {
        body = JSON.stringify(JSON.parse(e.reqBody || "{}"));
      } catch {
        body = JSON.stringify({ body: e.reqBody });
      }
    } else body = JSON.stringify({ error: "Blocked by the Crux write guard", status });
    return { status, body, delay: Math.max(0, Math.min(r.delay | 0, 60000)) };
  };
  const answered = (e, r, t0) => {
    e.status = r.status;
    e.ms = Math.round(performance.now() - t0);
    e.ctype = "application/json";
    e.size = r.body.length;
    e.resBody = r.body.slice(0, MAX_BODY);
    touch(e);
  };
  // "Ask each time": the UI polls for ask === "pending" and calls answer().
  const asks = new Map();
  const ask = (e) =>
    new Promise((resolve) => {
      e.ask = "pending";
      touch(e);
      const done = (ok) => {
        if (!asks.has(e.id)) return;
        asks.delete(e.id);
        e.ask = ok ? "allowed" : "blocked";
        e.blocked = !ok;
        if (ok) e.grant = "Allowed when asked (" + new Date().toLocaleTimeString() + ")";
        touch(e);
        resolve(ok);
      };
      asks.set(e.id, done);
      setTimeout(() => done(false), 120000);
    });

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
      const self = this;
      const args = arguments;
      const run = () =>
        origFetch.apply(self, args).then(
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
      const fake = () => {
        const r = reply(e);
        return wait(r.delay).then(() => {
          answered(e, r, t0);
          return new Response(r.body, { status: r.status, headers: { "content-type": "application/json", "x-crux-guard": "blocked" } });
        });
      };
      const go = () => {
        const act = judge(e);
        if (act === "block") return fake();
        if (act === "ask") return ask(e).then((ok) => (ok ? run() : fake()));
        return run();
      };
      // A Request's body is only readable async: read it before judging.
      if (req && e.reqBody == null && !SAFE[e.method] && window.__qlGuard && window.__qlGuard.on) {
        return req
          .clone()
          .text()
          .then((t) => (e.reqBody = t.slice(0, MAX_BODY)), () => {})
          .then(go);
      }
      return go();
    };
  }

  const XHR = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (XHR) {
    const open = XHR.open;
    const send = XHR.send;
    XHR.open = function (method, url, async) {
      this.__ql = { method: String(method || "GET").toUpperCase(), url: abs(url), sync: arguments.length > 2 && !async };
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
      const act = judge(e);
      if (act === "pass" || act === "allow") return send.apply(this, arguments);
      const x = this;
      const args = arguments;
      const fake = () => {
        const r = reply(e);
        setTimeout(() => {
          const def = (k, v) => Object.defineProperty(x, k, { configurable: true, get: () => v });
          let response = r.body;
          if (x.responseType === "json") {
            try {
              response = JSON.parse(r.body);
            } catch {
              response = null;
            }
          }
          def("readyState", 4);
          def("status", r.status);
          def("statusText", r.status < 300 ? "OK" : "Blocked");
          def("responseText", r.body);
          def("response", response);
          def("responseURL", e.url);
          x.getResponseHeader = (n) => ({ "content-type": "application/json", "x-crux-guard": "blocked" })[String(n).toLowerCase()] || null;
          x.getAllResponseHeaders = () => "content-type: application/json\r\nx-crux-guard: blocked\r\n";
          x.dispatchEvent(new Event("readystatechange"));
          for (const t of ["load", "loadend"]) x.dispatchEvent(new ProgressEvent(t, { lengthComputable: true, loaded: r.body.length, total: r.body.length }));
        }, r.delay);
      };
      // A synchronous request can't wait for an answer: it is blocked.
      if (act === "ask" && !info.sync) ask(e).then((ok) => (ok ? send.apply(x, args) : fake()));
      else fake();
    };
  }

  // sendBeacon has no response: a blocked one still reports "queued".
  const Nav = window.Navigator && Navigator.prototype;
  if (Nav && Nav.sendBeacon) {
    const beacon = Nav.sendBeacon;
    Nav.sendBeacon = function (url, data) {
      const nav = this;
      const e = add({ id: ++seq, type: "beacon", method: "POST", url: abs(url), start: Date.now(), status: 0, ms: 0, size: null, ctype: "", reqBody: preview(data), resBody: null, error: null });
      const sent = () => {
        const ok = beacon.call(nav, url, data);
        e.status = ok ? 202 : -1;
        touch(e);
        return ok;
      };
      const act = judge(e);
      if (act === "pass" || act === "allow") return sent();
      if (act === "ask") ask(e).then((ok) => (ok ? sent() : answered(e, reply(e), performance.now())));
      else answered(e, reply(e), performance.now());
      return true;
    };
  }

  // Form posts navigate away, so a blocked one just doesn't happen (the page stays).
  const Form = window.HTMLFormElement && HTMLFormElement.prototype;
  if (Form) {
    const submit = Form.submit;
    /** True when the guard stopped this submission. */
    const guardForm = (f) => {
      const g = window.__qlGuard;
      const method = String(f.method || "get").toUpperCase();
      if (!g || !g.on || SAFE[method] || method === "DIALOG") return false;
      let body = null;
      try {
        body = preview(new FormData(f));
      } catch {}
      const e = { id: ++seq, type: "form", method, url: abs(f.action || location.href), start: Date.now(), status: 0, ms: null, size: null, ctype: "", reqBody: body, resBody: null, error: null };
      const act = judge(e);
      if (act === "pass") return false;
      add(e);
      if (act === "allow") return false;
      const stop = () => {
        answered(e, reply(e), performance.now());
        e.resBody = "Form post answered by Crux: the page stays.";
      };
      if (act === "ask") ask(e).then((ok) => (ok ? submit.call(f) : stop()));
      else stop();
      return true;
    };
    Form.submit = function () {
      if (!guardForm(this)) return submit.call(this);
    };
    // Bubble phase, so pages that handle the submit themselves (fetch) aren't counted twice.
    window.addEventListener("submit", (ev) => {
      if (!ev.defaultPrevented && ev.target instanceof HTMLFormElement && guardForm(ev.target)) ev.preventDefault();
    });
  }

  window.__qlNet = {
    page,
    take: (since) => JSON.stringify({ page, url: location.href, version, entries: log.filter((x) => x.v > since) }),
    clear: () => {
      log.length = 0;
    },
    /** Answer an "ask each time" write: true lets it through. */
    answer: (id, ok) => {
      const done = asks.get(id);
      if (done) done(!!ok);
      return done ? "ok" : "gone";
    },
  };
})();
