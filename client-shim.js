(function (B) {
  var P = "/api/proxy?url=",
    O = location.origin;
  var IF = false;
  try {
    IF = window.parent !== window;
  } catch (e) {}
  function RP(m) {
    if (!IF) return;
    try {
      window.parent.postMessage(m, "*");
    } catch (e) {}
  }
  function RL(u) {
    var s = String(u),
      r = unpx(s);
    if (r) return r;
    try {
      return new URL(s, B).href;
    } catch (e) {
      return s;
    }
  }
  function RS() {
    RP({
      venomos: "page",
      url: String(B).replace(/#.*$/, ""),
      title: document.title || "",
      ready: document.readyState,
    });
  }
  function isP(s) {
    return s.indexOf(P) === 0 || s.indexOf(O + P) === 0;
  }
  function unpx(u) {
    var s = String(u);
    if (!isP(s)) return null;
    var r = s.slice(s.indexOf("?url=") + 5),
      h = r.indexOf("#");
    if (h > -1) r = r.slice(0, h);
    try {
      return decodeURIComponent(r);
    } catch (e) {
      return null;
    }
  }
  function px(u) {
    try {
      var s = String(u);
      if (
        !s ||
        s.charAt(0) === "#" ||
        /^(data|blob|javascript|mailto|tel|about):/i.test(s) ||
        isP(s)
      )
        return u;
      var x = new URL(s, B);
      if (x.protocol !== "http:" && x.protocol !== "https:") return u;
      if (x.host === location.host) {
        if (x.pathname === "/api/proxy") return u;
        x = new URL(x.pathname + x.search + x.hash, B);
      }
      var h = x.hash;
      x.hash = "";
      return P + encodeURIComponent(x.href) + h;
    } catch (e) {
      return u;
    }
  }
  var F = window.fetch;
  if (F)
    window.fetch = function (i, n) {
      var self = this;
      try {
        if (typeof i === "string" || i instanceof URL) i = px(i);
        else if (i && i.url && typeof Request !== "undefined" && i instanceof Request) {
          var u0 = i.url,
            u1 = px(u0);
          if (u1 !== u0) {
            var rq = i,
              mt = rq.method;
            if (mt === "GET" || mt === "HEAD") {
              i = new Request(new URL(u1, location.href).href, rq);
            } else {
              var nn = n;
              return rq
                .clone()
                .arrayBuffer()
                .then(function (b) {
                  var o = {
                    method: mt,
                    headers: rq.headers,
                    credentials: rq.credentials,
                    cache: rq.cache,
                    redirect: rq.redirect,
                    signal: rq.signal,
                  };
                  if (b.byteLength) o.body = b;
                  if (nn) {
                    o = Object.assign(o, nn);
                    delete o.referrer;
                  }
                  return F.call(self, u1, o);
                });
            }
          }
        }
        if (n && n.referrer) {
          n = Object.assign({}, n);
          delete n.referrer;
        }
      } catch (e) {}
      return F.call(this, i, n);
    };
  var XO = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u) {
    var a = [].slice.call(arguments);
    a[1] = px(u);
    return XO.apply(this, a);
  };
  var WO = window.open;
  window.open = function (u) {
    var a = [].slice.call(arguments);
    if (u && IF && !/^(javascript|data|blob|about|mailto|tel):/i.test(String(u))) {
      var ru = RL(u);
      if (/^https?:/i.test(ru)) {
        RP({ venomos: "open", url: ru });
        return null;
      }
    }
    if (u) a[0] = px(u);
    return WO.apply(this, a);
  };
  var WS = window.WebSocket;
  if (WS) {
    var PW = function (u, p) {
      var x,
        w = u;
      try {
        x = new URL(String(u), B);
        if (x.host === location.host) {
          if (x.pathname !== "/api/proxy") {
            x = new URL(x.pathname + x.search, B);
            w =
              (location.protocol === "https:" ? "wss:" : "ws:") +
              "//" +
              location.host +
              P +
              encodeURIComponent(x.href);
          }
        } else
          w =
            (location.protocol === "https:" ? "wss:" : "ws:") +
            "//" +
            location.host +
            P +
            encodeURIComponent(x.href);
      } catch (e) {}
      return arguments.length > 1 ? new WS(w, p) : new WS(w);
    };
    PW.prototype = WS.prototype;
    PW.CONNECTING = 0;
    PW.OPEN = 1;
    PW.CLOSING = 2;
    PW.CLOSED = 3;
    window.WebSocket = PW;
  }
  var ES = window.EventSource;
  if (ES) {
    var PE = function (u, o) {
      return new ES(px(u), o);
    };
    PE.prototype = ES.prototype;
    PE.CONNECTING = 0;
    PE.OPEN = 1;
    PE.CLOSED = 2;
    window.EventSource = PE;
  }
  var SB = navigator.sendBeacon;
  if (SB)
    navigator.sendBeacon = function (u, d) {
      return SB.call(navigator, px(u), d);
    };
  var WK = window.Worker;
  if (WK) {
    var PK = function (u, o) {
      return new WK(px(u), o);
    };
    PK.prototype = WK.prototype;
    window.Worker = PK;
  }
  try {
    if (navigator.serviceWorker)
      navigator.serviceWorker.register = function () {
        return Promise.reject(
          new DOMException("Service workers are not available in the proxy", "SecurityError"),
        );
      };
  } catch (e) {}
  try {
    Object.defineProperty(Navigator.prototype, "onLine", {
      get: function () {
        return true;
      },
      configurable: true,
    });
  } catch (e) {}
  var AT = { src: 1, href: 1, poster: 1, data: 1 };
  var TG = /^(script|link|img|source|iframe|frame|video|audio|track|embed|object|input)$/i;
  var SA = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (n, v) {
    var l = String(n).toLowerCase();
    if (AT[l] && this.namespaceURI === "http://www.w3.org/1999/xhtml" && TG.test(this.tagName))
      v = px(v);
    return SA.call(this, n, v);
  };
  function hp(C, p) {
    try {
      var c = window[C];
      if (!c) return;
      var d = Object.getOwnPropertyDescriptor(c.prototype, p);
      if (!d || !d.set) return;
      Object.defineProperty(c.prototype, p, {
        configurable: true,
        enumerable: d.enumerable,
        get: d.get,
        set: function (v) {
          d.set.call(this, px(v));
        },
      });
    } catch (e) {}
  }
  [
    ["HTMLScriptElement", "src"],
    ["HTMLImageElement", "src"],
    ["HTMLLinkElement", "href"],
    ["HTMLIFrameElement", "src"],
    ["HTMLSourceElement", "src"],
    ["HTMLMediaElement", "src"],
    ["HTMLEmbedElement", "src"],
    ["HTMLTrackElement", "src"],
    ["HTMLInputElement", "src"],
    ["HTMLObjectElement", "data"],
    ["HTMLVideoElement", "poster"],
  ].forEach(function (a) {
    hp(a[0], a[1]);
  });
  ["pushState", "replaceState"].forEach(function (k) {
    var o = history[k];
    history[k] = function (s, t, u) {
      if (u != null && u !== "") {
        try {
          var x = unpx(u) || new URL(String(u), B).href;
          B = x;
          var y = new URL(x);
          u = P + encodeURIComponent(y.href.replace(/#.*$/, "")) + y.hash;
        } catch (e) {}
      }
      var r = o.call(this, s, t, u);
      try {
        RS();
      } catch (e) {}
      return r;
    };
  });
  function fix(n) {
    if (!n || n.nodeType !== 1) return;
    var els = [n].concat(
      [].slice.call(
        n.querySelectorAll ? n.querySelectorAll("[src],[poster],link[href],object[data]") : [],
      ),
    );
    els.forEach(function (el) {
      if (!TG.test(el.tagName)) return;
      ["src", "poster", "href", "data"].forEach(function (a) {
        var v = el.getAttribute(a);
        if (v == null) return;
        if (a === "href" && el.tagName.toLowerCase() !== "link") return;
        var p = px(v);
        if (p !== v) SA.call(el, a, p);
      });
    });
  }
  try {
    new MutationObserver(function (ms) {
      ms.forEach(function (m) {
        [].forEach.call(m.addedNodes, fix);
      });
    }).observe(document, { childList: true, subtree: true });
  } catch (e) {}
  document.addEventListener(
    "click",
    function (e) {
      var a = e.target && e.target.closest && e.target.closest("a[href],area[href]");
      if (!a || e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
        return;
      var h = a.getAttribute("href") || "";
      if (
        IF &&
        a.getAttribute("target") === "_blank" &&
        !/^(javascript|mailto|tel|data|blob):/i.test(h) &&
        h.charAt(0) !== "#"
      ) {
        var ru = RL(h);
        if (/^https?:/i.test(ru)) {
          e.preventDefault();
          RP({ venomos: "open", url: ru });
          return;
        }
      }
      if (/^(javascript|mailto|tel|data|blob):/i.test(h) || isP(h)) return;
      if (h.charAt(0) === "#") {
        e.preventDefault();
        location.hash = h.slice(1);
        return;
      }
      var g = px(h);
      if (g === h) return;
      e.preventDefault();
      if (a.getAttribute("target") === "_blank") window.open(g);
      else location.href = g;
    },
    false,
  );
  document.addEventListener(
    "submit",
    function (e) {
      var f = e.target;
      if (!f || f.tagName !== "FORM" || e.defaultPrevented) return;
      if ((f.getAttribute("method") || "get").toLowerCase() !== "get") return;
      var x;
      try {
        x = new URL(unpx(f.getAttribute("action") || "") || f.getAttribute("action") || B, B);
      } catch (_) {
        return;
      }
      if (x.protocol !== "http:" && x.protocol !== "https:") return;
      e.preventDefault();
      var d;
      try {
        d = new FormData(f, e.submitter);
      } catch (_) {
        d = new FormData(f);
      }
      var q = new URLSearchParams();
      d.forEach(function (v, k) {
        if (typeof v === "string") q.append(k, v);
      });
      x.search = q.toString();
      location.href = px(x.href);
    },
    false,
  );
  function ytHost() {
    try {
      return /(^|\.)youtube(-nocookie)?\.com$/i.test(new URL(B).hostname);
    } catch (e) {
      return false;
    }
  }
  window.addEventListener(
    "click",
    function (e) {
      if (e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || !ytHost()) return;
      var a = null,
        pa = e.composedPath ? e.composedPath() : [];
      for (var k = 0; k < pa.length; k++) {
        var t = pa[k];
        if (t && t.tagName === "A" && t.getAttribute && t.getAttribute("href")) {
          a = t;
          break;
        }
      }
      if (!a || a.getAttribute("target") === "_blank" || a.hasAttribute("download")) return;
      var h = a.getAttribute("href") || "";
      if (!h || h.charAt(0) === "#" || /^(javascript|mailto|tel|data|blob):/i.test(h) || isP(h))
        return;
      var tg;
      try {
        tg = new URL(h, B);
      } catch (_) {
        return;
      }
      if (!/^https?:$/.test(tg.protocol) || !/(^|\.)youtube\.com$/i.test(tg.hostname)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      location.href = px(tg.href);
    },
    true,
  );
  try {
    if (window.navigation && navigation.addEventListener)
      navigation.addEventListener("navigate", function (e) {
        try {
          if (
            e.hashChange ||
            e.formData ||
            e.downloadRequest != null ||
            e.navigationType === "reload" ||
            e.navigationType === "traverse" ||
            !e.cancelable
          )
            return;
          if (e.destination.sameDocument) return;
          var d = new URL(e.destination.url);
          if (d.protocol !== "http:" && d.protocol !== "https:") return;
          if (d.origin === O && d.pathname === "/api/proxy" && d.searchParams.has("url")) return;
          var nx = px(d.href);
          if (nx === d.href) return;
          e.preventDefault();
          if (e.navigationType === "replace") location.replace(nx);
          else location.assign(nx);
        } catch (_) {}
      });
  } catch (_) {}
  RS();
  document.addEventListener("DOMContentLoaded", RS);
  window.addEventListener("load", RS);
  window.addEventListener("hashchange", RS);
  if (IF) {
    var LT = document.title;
    setInterval(function () {
      if (document.title !== LT) {
        LT = document.title;
        RS();
      }
    }, 800);
  }
});
