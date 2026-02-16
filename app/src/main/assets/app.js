const nativeLog = (msg) => {
  try { window.NativeLog?.log?.(String(msg)); } catch (_) {}
};

/* ---------------- Global error overlay (no DevTools needed) ---------------- */
(function () {
  const overlayId = "appErrorOverlay";
  const ensure = () => {
    let el = document.getElementById(overlayId);
    if (el) return el;
    el = document.createElement("div");
    el.id = overlayId;
    el.style.cssText =
      "position:fixed;inset:auto 12px 12px 12px;z-index:9999;max-height:40vh;overflow:auto;" +
      "background:#0f172a;color:#e2e8f0;border:1px solid rgba(148,163,184,.3);" +
      "border-radius:12px;padding:10px 12px;font-size:12px;line-height:1.4;display:none;" +
      "box-shadow:0 8px 22px rgba(0,0,0,.35)";
    document.body.appendChild(el);
    return el;
  };

  const show = (msg, src, line, col, stack) => {
    const el = ensure();
    const parts = [];
    parts.push(`JS Error: ${msg}`);
    if (src) parts.push(`Source: ${src}`);
    if (line || col) parts.push(`Line: ${line || 0}:${col || 0}`);
    if (stack) parts.push(`Stack: ${stack}`);
    const text = parts.join("\n");
    el.textContent = text;
    el.style.display = "block";
    try { console.error(text); } catch (_) {}
    nativeLog(text);
  };

  window.addEventListener("error", (e) => {
    show(e.message || "Unknown error", e.filename, e.lineno, e.colno, e.error?.stack);
  });

  window.addEventListener("unhandledrejection", (e) => {
    const reason = e.reason;
    show(
      reason?.message || String(reason),
      "",
      0,
      0,
      reason?.stack
    );
  });
})();

/* ---------------- Persistence: SharedPreferences via bridge ---------------- */
const Store = {
  hasNative: !!(window.NativeStore && NativeStore.getItem),
  get(key, fallback = null) {
    try {
      if (this.hasNative) {
        const v = NativeStore.getItem(key);
        return v ? JSON.parse(v) : fallback;
      }
      const s = localStorage.getItem(key);
      return s ? JSON.parse(s) : fallback;
    } catch (e) {
      return fallback;
    }
  },
  set(key, val) {
    const json = JSON.stringify(val);
    if (this.hasNative) NativeStore.setItem(key, json);
    else localStorage.setItem(key, json);
  },
  remove(key) {
    if (this.hasNative) NativeStore.removeItem(key);
    else localStorage.removeItem(key);
  }
};

/* ---------------- Lightweight cache + offline helpers ---------------- */
const Cache = {
  get(key, maxAgeMs = 10 * 60 * 1000) {
    const rec = Store.get(`cache:${key}`, null);
    if (!rec || typeof rec !== "object") return null;
    if (rec.t && (Date.now() - rec.t) > maxAgeMs) return null;
    return rec.v;
  },
  set(key, val) {
    Store.set(`cache:${key}`, { t: Date.now(), v: val });
  }
};

function isNetworkError(err) {
  if (!navigator.onLine) return true;
  const msg = String(err?.message || "");
  return err?.name === "TypeError" || /failed to fetch|networkerror|load failed|network/i.test(msg);
}

let _lastOfflineNotice = 0;
function notifyOffline(message) {
  const nowTs = Date.now();
  if (nowTs - _lastOfflineNotice < 15000) return;
  _lastOfflineNotice = nowTs;
  toast(message);
}

function setLastSync(ts = now()) {
  Store.set("lastSyncAt", ts);
  try { UI?.renderSyncMeta?.(); } catch (_) {}
}

function updateNetStatus() {
  const el = document.getElementById("netStatus");
  if (!el) return;
  const pending = OfflineQueue?.count?.() || 0;
  if (!navigator.onLine) {
    el.textContent = pending ? `Offline (${pending} pending)` : "Offline";
    el.classList.remove("hidden");
    return;
  }
  if (pending > 0) {
    el.textContent = `Syncing (${pending})`;
    el.classList.remove("hidden");
    return;
  }
  el.classList.add("hidden");
}

/* ---------------- API base + helpers ---------------- */
const API_BASE = "https://civicsweep-api.onrender.com";
let JWT = Store.get("jwt", null);

function setJWT(token) {
  JWT = token;
  if (token) Store.set("jwt", token);
  else Store.remove("jwt");
}

function decodeJwtPayload(token) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length < 2) return null;
    let b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
    const json = atob(b64 + pad);
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function isJwtExpired(token, skewSeconds = 60) {
  const p = decodeJwtPayload(token);
  if (!p || !p.exp) return true;
  const nowSec = Math.floor(Date.now() / 1000);
  return (p.exp - skewSeconds) <= nowSec;
}

function getOfflineAccounts() {
  return Store.get("offlineAccounts", []);
}

function setOfflineAccounts(list) {
  Store.set("offlineAccounts", list || []);
}

function accountKey(role, loginId) {
  return `${String(role || "").toLowerCase()}:${String(loginId || "").toLowerCase()}`;
}

function rememberSession(session, token, identifier) {
  if (!session || !token) return;
  Store.set("lastSession", session);
  Store.set("lastJwt", token);
  if (identifier) Store.set("lastLoginId", String(identifier).trim().toLowerCase());
  Store.set("lastLoginAt", now());

  const role = String(session.role || "").toLowerCase();
  const loginId = String(identifier || session.adminEmail || session.vendorId || session.userId || "").trim().toLowerCase();
  if (!role || !loginId) return;
  const list = getOfflineAccounts();
  const key = accountKey(role, loginId);
  const next = list.filter(a => a.key !== key);
  next.unshift({
    key,
    role,
    loginId,
    name: session.name || "",
    session,
    token,
    lastLoginAt: now()
  });
  setOfflineAccounts(next.slice(0, 5));
}

function getOfflineCandidate(key) {
  const list = getOfflineAccounts();
  let item = null;
  if (key) {
    item = list.find(a => a.key === key) || null;
  }
  if (!item) {
    const lastSession = Store.get("lastSession", null);
    const lastJwt = Store.get("lastJwt", null);
    const lastLoginId = Store.get("lastLoginId", null);
    if (lastSession && lastJwt) {
      const role = String(lastSession.role || "").toLowerCase();
      const loginId = String(lastLoginId || lastSession.adminEmail || lastSession.vendorId || lastSession.userId || "").trim().toLowerCase();
      if (role && loginId) {
        item = {
          key: accountKey(role, loginId),
          role,
          loginId,
          name: lastSession.name || "",
          session: lastSession,
          token: lastJwt,
          lastLoginAt: Store.get("lastLoginAt", null) || now()
        };
      }
    }
  }

  if (!item) return { ok: false, reason: "none" };
  if (isJwtExpired(item.token)) return { ok: false, reason: "expired" };
  const p = decodeJwtPayload(item.token);
  if (p?.role && item.session?.role) {
    const tokenRole = String(p.role).toLowerCase();
    const sessionRole = String(item.session.role).toLowerCase();
    if (tokenRole !== sessionRole) return { ok: false, reason: "mismatch" };
  }
  return { ok: true, item };
}

function findOfflineAccount(role, loginId) {
  const r = String(role || "").toLowerCase();
  const id = String(loginId || "").trim().toLowerCase();
  if (!r || !id) return { ok: false, reason: "missing" };
  const list = getOfflineAccounts();
  let item = list.find(a => a.role === r && a.loginId === id) || null;
  if (!item) {
    // legacy fallback
    const legacySession = Store.get("lastSession", null);
    const legacyJwt = Store.get("lastJwt", null);
    const legacyId = Store.get("lastLoginId", null);
    const legacyRole = String(legacySession?.role || "").toLowerCase();
    const legacyLogin = String(legacyId || "").trim().toLowerCase();
    if (legacySession && legacyJwt && legacyRole === r && legacyLogin === id) {
      item = {
        key: accountKey(r, id),
        role: r,
        loginId: id,
        name: legacySession.name || "",
        session: legacySession,
        token: legacyJwt,
        lastLoginAt: Store.get("lastLoginAt", null) || now()
      };
    }
  }
  if (!item) return { ok: false, reason: "not_found" };
  if (isJwtExpired(item.token)) return { ok: false, reason: "expired" };
  return { ok: true, item };
}

async function api(path, method = "GET", body, options = {}) {
  api.lastFromCache = false;
  const cacheKey = options.cacheKey || null;
  const cacheMaxAgeMs = options.cacheMaxAgeMs || (10 * 60 * 1000);

  if (method === "GET" && cacheKey && !navigator.onLine) {
    const cached = Cache.get(cacheKey, cacheMaxAgeMs);
    if (cached != null) {
      api.lastFromCache = true;
      return cached;
    }
  }

  const baseUrl = `${API_BASE}${path}`;
  const url = method === "GET"
    ? `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}t=${Date.now()}`
    : baseUrl;
  try { UI?.fx?.progressStart?.(); } catch(_){}
  let res;
  try {
    res = await fetch(url, {
      method,
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        ...(JWT ? { Authorization: `Bearer ${JWT}` } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (err) {
    if (method === "GET" && cacheKey && isNetworkError(err)) {
      const cached = Cache.get(cacheKey, cacheMaxAgeMs);
      if (cached != null) {
        api.lastFromCache = true;
        return cached;
      }
    }
    throw err;
  }
  try { UI?.fx?.progressStop?.(); } catch(_){}
  let data = null;
  try {
    data = await res.json();
  } catch (_) {}
  if (!res.ok) {
    const msg = (data && (data.error || data.message)) || `HTTP ${res.status}`;
    nativeLog(`API ${method} ${path} -> ${res.status} ${msg}`);
    throw new Error(msg);
  }
  if (navigator.onLine) setLastSync();
  if (method === "GET" && cacheKey) Cache.set(cacheKey, data);
  api.lastFromCache = false;
  return data;
}

/* ---------------- basics ---------------- */
function uid() { return Math.random().toString(36).slice(2, 8); }
function now() { return new Date().toISOString(); }
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
let Notifier = null;
try {
  if (window.Notyf) {
    Notifier = new window.Notyf({ duration: 2600, position: { x: "right", y: "top" } });
  }
} catch (_) {
  Notifier = null;
}
function toast(s) {
  try {
    if (Notifier) {
      Notifier.success(s);
      return;
    }
  } catch (_) {
    Notifier = null;
  }
  alert(s);
}
function oops(e) {
  const msg = e?.message || String(e);
  const name = e?.name || "";
  const stack = e?.stack || "";
  try { console.error(e); } catch (_) {}
  nativeLog(`oops: ${name} ${msg}\n${stack}`);
  try {
    if (Notifier) {
      Notifier.error(msg);
      return;
    }
  } catch (_) {
    Notifier = null;
  }
  alert(msg);
}

/* ---------------- Offline queue + sync ---------------- */
const OfflineQueue = {
  key: "offlineQueue",
  list: Store.get("offlineQueue", []),
  _flushing: false,
  _retryCount: 0,
  _nextRetryAt: null,
  _timer: null,
  save() {
    Store.set(this.key, this.list);
    updateNetStatus();
    try { UI?.renderPendingSync?.(); } catch (_) {}
  },
  count() { return this.list.length; },
  enqueue(item) {
    const entry = {
      id: item.id || `q_${Date.now()}_${uid()}`,
      type: item.type,
      payload: item.payload || {},
      createdAt: item.createdAt || now()
    };
    this.list.push(entry);
    this.save();
    if (navigator.onLine) this.scheduleFlush();
    return entry;
  },
  enqueueReport(payload) {
    const entry = this.enqueue({ type: "report.create", payload });
    return this.toReportStub(entry);
  },
  enqueueAction(type, payload) {
    return this.enqueue({ type, payload });
  },
  pendingReports() {
    return this.list.filter(i => i.type === "report.create");
  },
  retryInMs() {
    if (!this._nextRetryAt) return 0;
    return Math.max(0, this._nextRetryAt - Date.now());
  },
  scheduleFlush() {
    if (this._timer || !this.list.length) return;
    const base = 2000;
    const delay = Math.min(60000, base * Math.pow(2, this._retryCount));
    const jitter = Math.floor(Math.random() * 400);
    const ms = delay + jitter;
    this._nextRetryAt = Date.now() + ms;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flush();
    }, ms);
    try { UI?.renderPendingSync?.(); } catch (_) {}
  },
  clearSchedule() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this._nextRetryAt = null;
  },
  toReportStub(item) {
    const p = item.payload || {};
    const localId = item.id || `local_${uid()}`;
    return {
      id: localId,
      title: p.title || "Untitled report",
      desc: p.desc || "",
      lat: p.lat,
      lng: p.lng,
      address: p.address || "",
      photoBase64: p.photoBase64 || null,
      wasteType: (p.wasteTypeOverride && p.wasteTypeOverride !== "auto") ? p.wasteTypeOverride : null,
      wasteConfidence: null,
      status: "QUEUED",
      autoAssigned: false,
      autoAssignNote: "Queued offline. Will sync when online.",
      createdAt: item.createdAt,
      updatedAt: item.createdAt,
      offline: true
    };
  },
  async flush(force = false) {
    if (this._flushing) return;
    if (force) {
      this._retryCount = 0;
      this.clearSchedule();
    }
    if (!navigator.onLine) {
      if (force) notifyOffline("Offline. Sync will retry automatically.");
      this.scheduleFlush();
      return;
    }
    if (!this.list.length) { updateNetStatus(); return; }
    this._flushing = true;
    updateNetStatus();
    let remaining = [];
    let failedNet = false;
    for (let i = 0; i < this.list.length; i++) {
      const item = this.list[i];
      try {
        if (item.type === "report.create") {
          await api("/reports", "POST", item.payload);
        } else if (item.type === "vendor.complete") {
          await api("/reports/vendor/complete", "POST", item.payload);
        } else if (item.type === "admin.assign") {
          await api("/reports/assign", "POST", item.payload);
        } else if (item.type === "admin.status") {
          await api("/reports/status", "POST", item.payload);
        }
      } catch (e) {
        remaining = this.list.slice(i);
        const isNet = isNetworkError(e);
        failedNet = isNet;
        if (!isNet) remaining[0] = { ...item, error: e?.message || "Failed", failedAt: now() };
        break;
      }
    }
    this.list = remaining;
    this.save();
    this._flushing = false;
    updateNetStatus();
    if (!this.list.length) {
      this._retryCount = 0;
      this.clearSchedule();
      toast("Offline changes synced");
      if (Session?.data?.role) {
        await UI.route();
      }
      return;
    }
    // still pending
    if (navigator.onLine && failedNet) {
      this._retryCount = Math.min(this._retryCount + 1, 6);
      this.scheduleFlush();
    }
  }
};

/* ---------------- Reverse Geocoding (Nominatim) ---------------- */
// Cache: { "12.97160,77.59460": "Some address" }
const GeoCache = Store.get('geocache', {});
let _geoBusy = false;
let _geoQueue = [];

async function reverseGeocode(lat, lng){
  const key = `${Number(lat).toFixed(5)},${Number(lng).toFixed(5)}`;
  if (GeoCache[key]) return GeoCache[key];

  const exec = () => new Promise(async (resolve) => {
    try{
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}&accept-language=en&email=${encodeURIComponent('contact@civicsweep.app')}`;
      const res = await fetch(url, { headers: { 'Accept':'application/json' }});
      const j = await res.json().catch(()=>null);
      const addr = j?.display_name || null;
      if (addr){
        GeoCache[key] = addr;
        Store.set('geocache', GeoCache);
      }
      resolve(addr);
    }catch(_){ resolve(null); }
  });

  return new Promise((resolve)=>{
    _geoQueue.push(async ()=>{
      const r = await exec();
      resolve(r);
      setTimeout(()=>{
        _geoBusy = false;
        const next = _geoQueue.shift();
        if (next){ _geoBusy = true; next(); }
      }, 1100); // ~1 req/sec
    });
    if (!_geoBusy){ _geoBusy = true; (_geoQueue.shift())(); }
  });
}

/* ---------------- Image compression (before base64 upload) ---------------- */
async function compressImage(file, maxW = 1280, maxH = 1280, quality = 0.7) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        const ratio = Math.min(maxW / width, maxH / height, 1);
        width = Math.round(width * ratio);
        height = Math.round(height * ratio);

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);

        const dataUrl = canvas.toDataURL("image/jpeg", quality);
        resolve(dataUrl);
      };
      img.onerror = reject;
      img.src = fr.result;
    };
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

/* ---------------- Session ---------------- */
const Session = {
  data: Store.get("session", null),
  save() { Store.set("session", this.data); UI.sync(); UI.route(); },
  clear() { this.data = null; Store.remove("session"); setJWT(null); UI.sync(); UI.route(); }
};
if (Session.data && JWT && !isJwtExpired(JWT)) {
  rememberSession(Session.data, JWT);
}

/* ---------------- Auth (Render API) ---------------- */
const Auth = {
  async userSignup() {
    try {
      if (!navigator.onLine) return toast("Offline. Sign up requires internet.");
      const name = $("#uName").value.trim();
      const email = $("#uEmail").value.trim();
      const pass = $("#uPass").value.trim();
      if (!name || !email || !pass) return toast("Fill all fields");
      await api("/auth/user/signup", "POST", { name, email, password: pass });
      toast("Account created. Please login.");
      ["#uName", "#uEmail", "#uPass"].forEach(s => $(s).value = "");
    } catch (e) { oops(e); }
  },
  async userLogin() {
    try {
      if (!navigator.onLine) {
        const email = $("#uLoginEmail").value.trim();
        if (!email) return toast("Enter your email");
        const cand = findOfflineAccount("user", email);
        if (!cand.ok) return toast("Offline login not available for this account.");
        setJWT(cand.item.token);
        Session.data = cand.item.session;
        Session.save();
        return toast("Offline login successful");
      }
      const email = $("#uLoginEmail").value.trim();
      const pass = $("#uLoginPass").value.trim();
      const r = await api("/auth/user/login", "POST", { email, password: pass });
      setJWT(r.token);
      Session.data = { role: "user", userId: r.userId, name: r.name };
      rememberSession(Session.data, r.token, email);
      Session.save();
    } catch (e) { oops(e); }
  },
  async vendorLogin() {
    try {
      if (!navigator.onLine) {
        const id = $("#vId").value.trim();
        if (!id) return toast("Enter your vendor ID");
        const cand = findOfflineAccount("vendor", id);
        if (!cand.ok) return toast("Offline login not available for this account.");
        setJWT(cand.item.token);
        Session.data = cand.item.session;
        Session.save();
        return toast("Offline login successful");
      }
      const id = $("#vId").value.trim();
      const pass = $("#vPass").value.trim();
      const r = await api("/auth/vendor/login", "POST", { code: id, password: pass });
      setJWT(r.token);
      Session.data = { role: "vendor", vendorId: r.vendorId, name: r.name };
      rememberSession(Session.data, r.token, id);
      Session.save();
    } catch (e) { oops(e); }
  },
  async adminLogin() {
    try {
      if (!navigator.onLine) {
        const email = $("#aEmail").value.trim();
        if (!email) return toast("Enter your admin email");
        const cand = findOfflineAccount("admin", email);
        if (!cand.ok) return toast("Offline login not available for this account.");
        setJWT(cand.item.token);
        Session.data = cand.item.session;
        Session.save();
        return toast("Offline login successful");
      }
      const email = $("#aEmail").value.trim();
      const pass = $("#aPass").value.trim();
      const r = await api("/auth/admin/login", "POST", { email, password: pass });
      setJWT(r.token);
      Session.data = { role: "admin", adminEmail: r.adminEmail, name: r.name };
      rememberSession(Session.data, r.token, email);
      Session.save();
    } catch (e) { oops(e); }
  },
  logout() { Session.clear(); }
};

/* ---------------- Vendors (Render API) ---------------- */
const Vendors = {
  cache: Store.get("vendors_cache", []),
  async refresh() {
    try {
      // Expecting backend to expose: GET /vendors -> [{id, name}]
      const rows = await api("/vendors", "GET", null, { cacheKey: "vendors", cacheMaxAgeMs: 60 * 60 * 1000 });
      this.cache = rows || [];
      Store.set("vendors_cache", this.cache);
      if (api.lastFromCache) notifyOffline("Offline. Using last saved vendor list.");
    } catch (e) {
      // Fallback to cached list if API is not present
      this.cache = Store.get("vendors_cache", this.cache || []);
    }
    this.populateSelect();
  },
  populateSelect() {
    const sel = $("#aVendor");
    if (!sel) return;
    sel.textContent = "";
    if (!this.cache || !this.cache.length) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "No vendors";
      sel.appendChild(opt);
      return;
    }
    this.cache.forEach(v => {
      const opt = document.createElement("option");
      opt.value = String(v.id ?? "");
      const tag = v.wasteType ? `${v.wasteType}` : "general";
      opt.textContent = `${v.name ?? ""} (${tag})`.trim();
      sel.appendChild(opt);
    });
  }
};

/* ---------------- Reports (Render API) ---------------- */
const Reports = {
  _userRows: [],
  _userLimit: 5,
  _userStep: 5,
  _adminRows: [],
  _adminLimit: 5,
  _adminStep: 5,
  fileToDataUrl(file) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = rej;
      fr.readAsDataURL(file);
    });
  },
  useMyLocation() {
    if (!navigator.geolocation) return toast("Geolocation not supported");
    navigator.geolocation.getCurrentPosition(p => {
      $("#rLat").value = p.coords.latitude.toFixed(6);
      $("#rLng").value = p.coords.longitude.toFixed(6);
      UI.mapPickSet([p.coords.latitude, p.coords.longitude], true);
      reverseGeocode(p.coords.latitude, p.coords.longitude).then(addr=>{ window.__geoAddr = addr || null; UI.setAddress(addr); });
    }, () => toast("Location permission denied"));
  },
  async submit() {
    try {
      nativeLog("Submit report: start");
      const s = Session.data; if (!s || s.role !== "user") return toast("Login as user first");
      const title = $("#rTitle").value.trim();
      if (!title) return toast("Add a title");
      const desc = $("#rDesc").value.trim();
      const wasteTypeOverride = $("#rWasteType")?.value || "auto";
      const lat = parseFloat($("#rLat").value);
      const lng = parseFloat($("#rLng").value);
      if (Number.isNaN(lat) || Number.isNaN(lng)) return toast("Set location (use map or GPS)");
      const f = $("#rPhoto").files?.[0];

      // compress before sending (higher quality for AI detection accuracy)
      let photoBase64 = null;
      if (f) {
        photoBase64 = await compressImage(f, 1600, 1600, 0.85);
      }

      const payload = { title, desc, lat, lng, photoBase64, address: (window.__geoAddr || null), wasteTypeOverride };
      if (!navigator.onLine) {
        const stub = OfflineQueue.enqueueReport(payload);
        this._userRows = [stub, ...(this._userRows || [])];
        this._userLimit = this._userStep;
        UI.renderTable("#userReports", this._userRows);
        toast("Offline. Report saved and will sync automatically.");
      } else {
        try {
          const created = await api("/reports", "POST", payload);
          nativeLog(`Submit report: ok ${created?.id ? `id=${created.id}` : ""}`.trim());
          toast("Report submitted");
        } catch (e) {
          if (isNetworkError(e)) {
            const stub = OfflineQueue.enqueueReport(payload);
            this._userRows = [stub, ...(this._userRows || [])];
            this._userLimit = this._userStep;
            UI.renderTable("#userReports", this._userRows);
            toast("Network issue. Report queued for sync.");
          } else {
            throw e;
          }
        }
      }

      ["#rTitle", "#rDesc", "#rLat", "#rLng"].forEach(sel => $(sel).value = "");
      if ($("#rWasteType")) $("#rWasteType").value = "auto";
      $("#rPhoto").value = ""; $("#rPreview").classList.add("hidden");
      this.refreshUserTable();
    } catch (e) { oops(e); }
  },
  async refreshUserTable() {
    try {
      const s = Session.data; if (!s || s.role !== "user") return;
      UI.fx?.skeletonStart?.('#userReports');
      const reports = await api("/reports/me", "GET", null, { cacheKey: "reports.me", cacheMaxAgeMs: 5 * 60 * 1000 });
      if (api.lastFromCache) notifyOffline("Offline. Showing last saved reports.");
      const queued = OfflineQueue.pendingReports().map(i => OfflineQueue.toReportStub(i));
      this._userRows = [...queued, ...(reports || [])];
      this._userLimit = this._userStep;
      UI.renderTable("#userReports", this._userRows);
      UI.fx?.initTooltips?.('#userReports');
      UI.fx?.revealRows?.('#userReports');
    } catch (e) {
      if (isNetworkError(e)) {
        const queued = OfflineQueue.pendingReports().map(i => OfflineQueue.toReportStub(i));
        this._userRows = queued;
        this._userLimit = this._userStep;
        UI.renderTable("#userReports", this._userRows);
        notifyOffline("Offline. No cached reports yet.");
      } else {
        oops(e);
      }
    }
    finally { UI.fx?.skeletonStop?.('#userReports'); }
  },
  async refreshVendorTable() {
    try {
      const s = Session.data; if (!s || s.role !== "vendor") return;
      UI.fx?.skeletonStart?.('#vendorTasks');
      const reports = await api("/reports/vendor", "GET", null, { cacheKey: "reports.vendor", cacheMaxAgeMs: 5 * 60 * 1000 });
      if (api.lastFromCache) notifyOffline("Offline. Showing last saved tasks.");
      UI.renderTable("#vendorTasks", (reports || []));
      UI.fx?.initTooltips?.('#vendorTasks');
      UI.fx?.revealRows?.('#vendorTasks');
    } catch (e) {
      if (isNetworkError(e)) {
        UI.renderTable("#vendorTasks", []);
        notifyOffline("Offline. No cached vendor tasks yet.");
      } else {
        oops(e);
      }
    }
    finally { UI.fx?.skeletonStop?.('#vendorTasks'); }
  },
  async refreshAdminTable() {
    try {
      const s = Session.data;
      if (!s || s.role !== "admin" || !JWT) return;
      const filter = $("#aFilter").value || "all";
      const q = ($("#aSearch").value || "");
      UI.fx?.skeletonStart?.('#adminReports');
      const cacheKey = `reports.admin.${filter}.${q || "all"}`;
      const reports = await api(`/reports?status=${encodeURIComponent(filter)}&q=${encodeURIComponent(q)}`, "GET", null, { cacheKey, cacheMaxAgeMs: 5 * 60 * 1000 });
      if (api.lastFromCache) notifyOffline("Offline. Showing last saved admin view.");
      this._adminRows = reports || [];
      this._adminLimit = this._adminStep;
      UI.renderTable("#adminReports", this._adminRows);
      UI.fx?.initTooltips?.('#adminReports');
      UI.fx?.revealRows?.('#adminReports');
      // Ensure vendor dropdown is up to date
      await Vendors.refresh();
    } catch (e) {
      if (isNetworkError(e)) {
        UI.renderTable("#adminReports", []);
        notifyOffline("Offline. No cached admin data yet.");
      } else {
        oops(e);
      }
    }
    finally { UI.fx?.skeletonStop?.('#adminReports'); }
  },
  async assign() {
    try {
      const id = $("#aReportId").value.trim(), vendorId = $("#aVendor").value;
      if (!id || !vendorId) return toast("Enter Report ID and select a vendor");
      if (!navigator.onLine) {
        OfflineQueue.enqueueAction("admin.assign", { reportId: id, vendorId });
        toast("Offline. Assignment queued.");
        updateNetStatus();
        return;
      }
      await api("/reports/assign", "POST", { reportId: id, vendorId });
      toast("Assigned");
      this.refreshAdminTable();
    } catch (e) { oops(e); }
  },
  async adminUpdateStatus() {
    try {
      const id = $("#aStatusId").value.trim(), st = $("#aStatusVal").value;
      if (!id || !st) return toast("Enter Report ID and select a status");
      if (!navigator.onLine) {
        OfflineQueue.enqueueAction("admin.status", { reportId: id, status: st });
        toast("Offline. Status update queued.");
        updateNetStatus();
        return;
      }
      await api("/reports/status", "POST", { reportId: id, status: st });
      toast("Status updated");
      this.refreshAdminTable(); this.refreshUserTable(); this.refreshVendorTable();
    } catch (e) { oops(e); }
  },
  async vendorComplete() {
    try {
      const s = Session.data; if (!s || s.role !== "vendor") return;
      const id = $("#vReportId").value.trim(); const file = $("#vProof").files?.[0];
      if (!id || !file) return toast("Enter Report ID & attach proof");

      // compress vendor proof too
      const proofBase64 = await compressImage(file, 1280, 1280, 0.7);

      if (!navigator.onLine) {
        OfflineQueue.enqueueAction("vendor.complete", { reportId: id, proofBase64 });
        toast("Offline. Completion queued.");
        updateNetStatus();
        $("#vProof").value = ""; $("#vReportId").value = "";
        return;
      }
      await api("/reports/vendor/complete", "POST", { reportId: id, proofBase64 });
      toast("Completed");
      $("#vProof").value = ""; $("#vReportId").value = "";
      this.refreshVendorTable(); this.refreshAdminTable(); this.refreshUserTable();
    } catch (e) { oops(e); }
  }
};

/* ---------------- UI ---------------- */
const UI = {
  _map: null,
  _marker: null,
  fx: {
    reduce() { return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; },
    progressStart(){
      const el = document.getElementById('progressbar'); if (!el) return;
      el.style.transition = 'transform .25s var(--ease)';
      el.style.transform = 'scaleX(.2)';
      clearTimeout(this._pt1); clearTimeout(this._pt2);
      this._pt1 = setTimeout(()=>{ el.style.transition = 'transform .6s var(--ease)'; el.style.transform='scaleX(.6)'; }, 200);
    },
    progressStop(){
      const el = document.getElementById('progressbar'); if (!el) return;
      el.style.transition = 'transform .25s var(--ease)';
      el.style.transform = 'scaleX(1)';
      clearTimeout(this._pt2);
      this._pt2 = setTimeout(()=>{ el.style.transition='transform .3s var(--ease)'; el.style.transform='scaleX(0)'; }, 250);
    },
    skeletonStart(sel){
      const c = document.querySelector(sel); if (!c) return;
      c.setAttribute('data-loading','true');
      c.innerHTML = `<div class="space-y-3 p-3 animate-pulse">
        <div class="h-4 w-1/3 rounded bg-slate-200 dark:bg-slate-700"></div>
        ${Array.from({length:4}).map(()=>`<div class=\"h-4 w-full rounded bg-slate-200 dark:bg-slate-700\"></div>`).join('')}
      </div>`;
    },
    skeletonStop(sel){
      const c = document.querySelector(sel); if (!c) return;
      c.removeAttribute('data-loading');
    },
    initTooltips(scope){
      const root = typeof scope === 'string' ? document.querySelector(scope) : scope || document;
      if (!root) return;
      // Tooltips removed (no external tooltip lib)
    },
    revealRows(scope){
      const root = typeof scope === 'string' ? document.querySelector(scope) : scope || document;
      if (!root) return;
      const rows = root.querySelectorAll('tbody tr');
      if (!rows.length) return;
      rows.forEach((r, idx) => {
        r.classList.remove('row-reveal');
        r.style.animationDelay = `${Math.min(idx * 40, 240)}ms`;
        r.classList.add('row-reveal');
      });
    },
    tabSwitch(el){
      if (this.reduce()) return;
      el.classList.remove('panel-reveal');
      requestAnimationFrame(() => el.classList.add('panel-reveal'));
    }
  },

  copyText(text) {
    if (!text) return;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(() => {});
        return;
      }
    } catch (_) {}
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "true");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    } catch (_) {}
  },

  sync() {
    const s = Session.data;
    $("#whoami").textContent = s ? `${s.role.toUpperCase()} - ${s.name || s.vendorId || s.adminEmail}` : "Not signed in";
  },

  renderPendingSync() {
    const wrap = $("#pendingSync");
    if (!wrap) return;
    const btn = $("#syncNowBtn");
    const pending = OfflineQueue.pendingReports();
    wrap.textContent = "";

    if (btn) {
      btn.disabled = pending.length === 0;
    }

    if (!pending.length) {
      const p = document.createElement("p");
      p.className = "text-sm text-slate-500 dark:text-slate-400";
      p.textContent = "No pending uploads.";
      wrap.appendChild(p);
      return;
    }

    const info = document.createElement("div");
    info.className = "text-xs text-slate-500 dark:text-slate-400";
    const retryMs = OfflineQueue.retryInMs();
    const retryText = retryMs > 0 ? `Next retry in ${Math.ceil(retryMs / 1000)}s.` : "Sync will retry automatically.";
    info.textContent = navigator.onLine ? retryText : "Offline. Will sync when you’re online.";
    wrap.appendChild(info);

    pending.forEach((item) => {
      const row = document.createElement("div");
      row.className = "flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white/80 px-3 py-2 text-xs text-slate-600 shadow-sm dark:border-slate-800 dark:bg-slate-950 dark:text-slate-300";

      const left = document.createElement("div");
      left.className = "min-w-0";
      const title = document.createElement("div");
      title.className = "font-semibold text-slate-800 dark:text-slate-100";
      title.textContent = item.payload?.title || "Untitled report";
      const meta = document.createElement("div");
      meta.className = "text-[11px] text-slate-500 dark:text-slate-400";
      const d = item.createdAt ? new Date(item.createdAt) : null;
      meta.textContent = d && !Number.isNaN(d.getTime()) ? d.toLocaleString() : "";
      left.appendChild(title);
      left.appendChild(meta);

      const right = document.createElement("div");
      right.className = "inline-flex items-center gap-2";
      const chip = document.createElement("span");
      chip.className = "inline-flex items-center rounded-full border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold text-indigo-700 dark:border-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-200";
      chip.textContent = "QUEUED";
      right.appendChild(chip);

      if (item.error) {
        const err = document.createElement("span");
        err.className = "text-[10px] text-rose-600 dark:text-rose-300";
        err.textContent = `Error: ${item.error}`;
        right.appendChild(err);
      }

      row.appendChild(left);
      row.appendChild(right);
      wrap.appendChild(row);
    });
  },

  renderSyncMeta() {
    const raw = Store.get("lastSyncAt", null);
    const ts = raw ? new Date(raw) : null;
    const text = ts && !Number.isNaN(ts.getTime()) ? ts.toLocaleString() : "never";
    const ids = ["lastSyncUser", "lastSyncVendor", "lastSyncAdmin"];
    ids.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    });
  },

  renderOfflineResume() {
    const wrap = $("#offlineResume");
    if (!wrap) return;
    if (Session.data) {
      wrap.classList.add("hidden");
      return;
    }
    if (navigator.onLine) {
      wrap.classList.add("hidden");
      return;
    }

    wrap.classList.remove("hidden");
  },

  clearOfflineSession() {
    Store.remove("offlineAccounts");
    Store.remove("lastSession");
    Store.remove("lastJwt");
    Store.remove("lastLoginAt");
    Store.remove("lastLoginId");
    this.renderOfflineResume();
    toast("Saved offline session cleared");
  },

  async syncNow() {
    await OfflineQueue.flush(true);
    if (!navigator.onLine) return;
    const role = Session?.data?.role || "";
    if (role === "user") await Reports.refreshUserTable();
    if (role === "vendor") await Reports.refreshVendorTable();
    if (role === "admin") await Reports.refreshAdminTable();
  },

  async route() {
    const s = Session.data;
    if (s && (!JWT || isJwtExpired(JWT))) {
      Session.clear();
      toast("Session expired. Please login online.");
      return;
    }
    this.renderSyncMeta();
    document.documentElement.classList.toggle('no-x-scroll', s?.role === "vendor");
    document.body.classList.toggle('no-x-scroll', s?.role === "vendor");
    const scrs = ["#authSection", "#userDash", "#vendorDash", "#adminDash"];
    const showId = !s ? "#authSection" : (s.role === "user" ? "#userDash" : s.role === "vendor" ? "#vendorDash" : "#adminDash");
    scrs.forEach(id => {
      const el = $(id);
      if (id === showId) this.showScreen(el);
      else this.hideScreen(el);
    });

    if (!s) {
      this.renderOfflineResume();
      return;
    }
    if (s.role === "user") {
      UI.renderPendingSync();
      await Reports.refreshUserTable();
    }
    if (s.role === "vendor") await Reports.refreshVendorTable();
    if (s.role === "admin") {
      await Vendors.refresh(); // keep vendor list in sync for assignment
      await Reports.refreshAdminTable();
    }
  },

  showScreen(el) {
    el.classList.remove("hidden");
    el.setAttribute("aria-hidden", "false");
    requestAnimationFrame(() => {
      el.classList.add("show");
      try { this.fx.tabSwitch(el); } catch(_){}
    });
  },

  hideScreen(el) {
    el.classList.remove("show");
    el.setAttribute("aria-hidden", "true");
    setTimeout(() => el.classList.add("hidden"), 350);
  },

  // Show address preview under lat/lng inputs on report form
  setAddress(addr){
    const el = document.querySelector('#rAddr');
    if (!el) return;
    if (addr){
      el.textContent = "";
      const span = document.createElement("span");
      span.className = "text-xs text-slate-500 dark:text-slate-400";
      span.title = addr;
      span.textContent = `Location: ${addr}`;
      el.appendChild(span);
    } else {
      el.textContent = '';
    }
  },

  renderTable(sel, rows) {
    const tgt = $(sel);
    tgt.textContent = "";
    if (!rows || !rows.length) {
      const p = document.createElement("p");
      p.className = "p-4 text-sm text-slate-500 dark:text-slate-400";
      p.textContent = "No records.";
      tgt.appendChild(p);
      return;
    }

    if (sel === "#userReports") {
      this.renderUserReports(tgt, rows);
      return;
    }
    if (sel === "#adminReports") {
      this.renderAdminReports(tgt, rows);
      return;
    }
    if (sel === "#vendorTasks") {
      this.renderVendorReports(tgt, rows);
      return;
    }

    const table = document.createElement("table");
    table.className = "w-full table-fixed text-sm text-left text-slate-600 dark:text-slate-300";

    const thead = document.createElement("thead");
    const trh = document.createElement("tr");
    ["ID", "Details", "Status", "Vendor", "Updated"].forEach(h => {
      const th = document.createElement("th");
      th.className = "px-3 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500 bg-slate-50 dark:bg-slate-900 dark:text-slate-400";
      th.textContent = h;
      trh.appendChild(th);
    });
    thead.appendChild(trh);

    const tbody = document.createElement("tbody");

    const badgeClass = st => {
      const k = (st || "").toLowerCase();
      const map = {
        "new": "border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200",
        "assigned": "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-700 dark:bg-amber-900/40 dark:text-amber-200",
        "in_progress": "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-700 dark:bg-sky-900/40 dark:text-sky-200",
        "resolved": "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200",
        "queued": "border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-200"
      };
      return map[k] || map.new;
    };

    rows.forEach(r => {
      const tr = document.createElement("tr");
      tr.className = "border-b border-slate-200/70 transition hover:bg-emerald-50/50 dark:border-slate-800 dark:hover:bg-emerald-500/10";

      const tdId = document.createElement("td");
      tdId.className = "px-3 py-3 text-xs text-slate-500 dark:text-slate-400 w-24";
      const idFull = String(r.id ?? "");
      const idShort = idFull.length > 10 ? `${idFull.slice(0, 6)}...${idFull.slice(-4)}` : idFull;
      tdId.textContent = idShort;
      if (idFull) tdId.title = idFull;

      const tdDetails = document.createElement("td");
      tdDetails.className = "px-3 py-3 break-words";

      const title = document.createElement("div");
      title.className = "font-semibold text-slate-900 dark:text-slate-100";
      title.textContent = r.title || "";
      tdDetails.appendChild(title);

      const desc = document.createElement("div");
      desc.className = "text-xs text-slate-500 dark:text-slate-400";
      desc.textContent = r.desc || "";
      tdDetails.appendChild(desc);

      const lat = Number(r.lat);
      const lng = Number(r.lng);
      const latText = Number.isFinite(lat) ? lat.toFixed(5) : "";
      const lngText = Number.isFinite(lng) ? lng.toFixed(5) : "";
      if (latText || lngText) {
        const loc = document.createElement("div");
        loc.className = "mt-2 flex flex-wrap items-center gap-2";
        const chip = document.createElement("span");
        chip.className = "report-chip";
        chip.textContent = `Loc: ${latText}, ${lngText}`;
        loc.appendChild(chip);
        tdDetails.appendChild(loc);
      }

      if (r.address) {
        const addr = document.createElement("div");
        addr.className = "text-xs text-slate-500 dark:text-slate-400 mt-2";
        addr.title = r.address;
        addr.textContent = r.address;
        tdDetails.appendChild(addr);
      }

      if (r.photoBase64 && /^data:image\//i.test(r.photoBase64)) {
        const wrap = document.createElement("div");
        wrap.className = "mt-3 flex flex-wrap items-center gap-3";
        const img = document.createElement("img");
        img.src = r.photoBase64;
        img.alt = "Report photo";
        img.className = "report-thumb";
        img.loading = "lazy";
        img.addEventListener("click", () => UI.openPhotoModal(r.photoBase64));
        const btn = document.createElement("button");
        btn.className = "inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-sm transition hover:-translate-y-0.5 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800";
        btn.innerHTML = "<i class=\"ri-image-2-line\"></i>View photo";
        btn.addEventListener("click", () => UI.openPhotoModal(r.photoBase64));
        wrap.appendChild(img);
        wrap.appendChild(btn);
        tdDetails.appendChild(wrap);
      }

      if (r.vendorProofBase64 && /^data:image\//i.test(r.vendorProofBase64)) {
        const proofWrap = document.createElement("div");
        proofWrap.className = "mt-2 flex flex-wrap items-center gap-2";
        const proof = document.createElement("span");
        proof.className = "report-chip";
        proof.textContent = "Proof uploaded";
        const proofBtn = document.createElement("button");
        proofBtn.className = "inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-sm transition hover:-translate-y-0.5 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800";
        proofBtn.innerHTML = "<i class=\"ri-image-2-line\"></i>View proof";
        proofBtn.addEventListener("click", () => UI.openPhotoModal(r.vendorProofBase64));
        proofWrap.appendChild(proof);
        proofWrap.appendChild(proofBtn);
        tdDetails.appendChild(proofWrap);
      }

      const tdStatus = document.createElement("td");
      tdStatus.className = "px-3 py-3 w-28";
      const badge = document.createElement("span");
      badge.className = `inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${badgeClass(r.status)}`;
      badge.textContent = r.status || "";
      tdStatus.appendChild(badge);

      const tdVendor = document.createElement("td");
      tdVendor.className = "px-3 py-3 text-sm text-slate-600 dark:text-slate-300 w-28";
      tdVendor.textContent = r.assignedVendorId || "-";

      const tdUpdated = document.createElement("td");
      tdUpdated.className = "px-3 py-3 text-xs text-slate-500 dark:text-slate-400 w-36";
      const rawTime = r.updatedAt || r.createdAt;
      if (rawTime) {
        const d = new Date(rawTime);
        tdUpdated.textContent = Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
      } else {
        tdUpdated.textContent = "";
      }

      tr.appendChild(tdId);
      tr.appendChild(tdDetails);
      tr.appendChild(tdStatus);
      tr.appendChild(tdVendor);
      tr.appendChild(tdUpdated);
      tbody.appendChild(tr);
    });

    table.appendChild(thead);
    table.appendChild(tbody);
    tgt.appendChild(table);
  },

  renderVendorReports(tgt, rows) {
    const table = document.createElement("table");
    table.className = "w-full table-auto border-separate border-spacing-x-4 border-spacing-y-2 text-sm text-left text-slate-600 dark:text-slate-300";

    const thead = document.createElement("thead");
    const trh = document.createElement("tr");
    ["ID", "View", "Copy ID"].forEach(h => {
      const th = document.createElement("th");
      th.className = "px-2 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500 bg-slate-50 dark:bg-slate-900 dark:text-slate-400";
      th.textContent = h;
      trh.appendChild(th);
    });
    thead.appendChild(trh);

    const tbody = document.createElement("tbody");
    rows.forEach(r => {
      const tr = document.createElement("tr");
      tr.className = "border-b border-slate-200/70 transition hover:bg-emerald-50/50 dark:border-slate-800 dark:hover:bg-emerald-500/10";

      const idFull = String(r.id ?? "");
      const idShort = idFull.length > 10 ? `${idFull.slice(0, 6)}...${idFull.slice(-4)}` : idFull;

      const tdId = document.createElement("td");
      tdId.className = "px-2 py-2 text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap";
      tdId.textContent = idShort;
      if (idFull) tdId.title = idFull;

      const tdView = document.createElement("td");
      tdView.className = "px-2 py-2";
      const viewBtn = document.createElement("button");
      viewBtn.className = "inline-flex min-w-[72px] max-w-[120px] items-center justify-center gap-1 overflow-hidden whitespace-nowrap rounded-lg bg-slate-900 px-2 py-1.5 text-[11px] font-semibold text-white shadow-sm transition hover:-translate-y-0.5 hover:bg-slate-800 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-100";
      viewBtn.innerHTML = "<i class=\"ri-eye-line\"></i><span class=\"truncate\">View</span>";
      viewBtn.addEventListener("click", () => UI.openReportModal(r));
      tdView.appendChild(viewBtn);

      const tdCopy = document.createElement("td");
      tdCopy.className = "px-2 py-2";
      const copyBtn = document.createElement("button");
      copyBtn.className = "inline-flex min-w-[72px] max-w-[120px] items-center justify-center gap-1 overflow-hidden whitespace-nowrap rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-[11px] font-semibold text-slate-700 shadow-sm transition hover:-translate-y-0.5 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800";
      copyBtn.innerHTML = "<i class=\"ri-clipboard-line\"></i><span class=\"truncate\">Copy ID</span>";
      copyBtn.addEventListener("click", () => {
        UI.copyText(idFull || "");
        const vRid = document.getElementById("vReportId");
        if (vRid) vRid.value = idFull || "";
        toast("Report ID copied");
      });
      tdCopy.appendChild(copyBtn);

      tr.appendChild(tdId);
      tr.appendChild(tdView);
      tr.appendChild(tdCopy);
      tbody.appendChild(tr);
    });

    table.appendChild(thead);
    table.appendChild(tbody);
    tgt.appendChild(table);
  },

  renderAdminReports(tgt, rows) {
    const allRows = (Reports._adminRows && Reports._adminRows.length) ? Reports._adminRows : rows || [];
    const limit = Math.max(1, Reports._adminLimit || allRows.length);
    const visible = allRows.slice(0, limit);

    const table = document.createElement("table");
    table.className = "w-full table-auto border-separate border-spacing-x-4 border-spacing-y-2 text-sm text-left text-slate-600 dark:text-slate-300";

    const thead = document.createElement("thead");
    const trh = document.createElement("tr");
    ["ID", "View", "Copy ID"].forEach(h => {
      const th = document.createElement("th");
      th.className = "px-2 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500 bg-slate-50 dark:bg-slate-900 dark:text-slate-400";
      th.textContent = h;
      trh.appendChild(th);
    });
    thead.appendChild(trh);

    const tbody = document.createElement("tbody");
    visible.forEach(r => {
      const tr = document.createElement("tr");
      tr.className = "border-b border-slate-200/70 transition hover:bg-emerald-50/50 dark:border-slate-800 dark:hover:bg-emerald-500/10";

      const idFull = String(r.id ?? "");
      const idShort = idFull.length > 10 ? `${idFull.slice(0, 6)}...${idFull.slice(-4)}` : idFull;

      const tdId = document.createElement("td");
      tdId.className = "px-2 py-2 text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap";
      tdId.textContent = idShort;
      if (idFull) tdId.title = idFull;

      const tdView = document.createElement("td");
      tdView.className = "px-2 py-2";
      const viewBtn = document.createElement("button");
      viewBtn.className = "inline-flex min-w-[72px] max-w-[120px] items-center justify-center gap-1 overflow-hidden whitespace-nowrap rounded-lg bg-slate-900 px-2 py-1.5 text-[11px] font-semibold text-white shadow-sm transition hover:-translate-y-0.5 hover:bg-slate-800 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-100";
      viewBtn.innerHTML = "<i class=\"ri-eye-line\"></i><span class=\"truncate\">View</span>";
      viewBtn.addEventListener("click", () => UI.openReportModal(r));
      tdView.appendChild(viewBtn);

      const tdCopy = document.createElement("td");
      tdCopy.className = "px-2 py-2";
      const copyBtn = document.createElement("button");
      copyBtn.className = "inline-flex min-w-[72px] max-w-[120px] items-center justify-center gap-1 overflow-hidden whitespace-nowrap rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-[11px] font-semibold text-slate-700 shadow-sm transition hover:-translate-y-0.5 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800";
      copyBtn.innerHTML = "<i class=\"ri-clipboard-line\"></i><span class=\"truncate\">Copy ID</span>";
      copyBtn.addEventListener("click", () => {
        UI.copyText(idFull || "");
        const aRid = document.getElementById("aReportId");
        const aSid = document.getElementById("aStatusId");
        if (aRid) aRid.value = idFull || "";
        if (aSid) aSid.value = idFull || "";
        toast("Report ID copied");
      });
      tdCopy.appendChild(copyBtn);

      tr.appendChild(tdId);
      tr.appendChild(tdView);
      tr.appendChild(tdCopy);
      tbody.appendChild(tr);
    });

    table.appendChild(thead);
    table.appendChild(tbody);
    tgt.appendChild(table);

    if (allRows.length > limit) {
      const footer = document.createElement("div");
      footer.className = "mt-3 flex flex-wrap items-center justify-between gap-2 px-4 pb-4";
      const meta = document.createElement("div");
      meta.className = "text-xs text-slate-500 dark:text-slate-400";
      meta.textContent = `Showing ${visible.length} of ${allRows.length} reports`;
      const btn = document.createElement("button");
      btn.className = "inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-sm transition hover:-translate-y-0.5 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800";
      btn.innerHTML = "<i class=\"ri-more-line\"></i>Load more";
      btn.addEventListener("click", () => {
        Reports._adminLimit = Math.min(allRows.length, limit + Reports._adminStep);
        UI.renderTable("#adminReports", allRows);
      });
      footer.appendChild(meta);
      footer.appendChild(btn);
      tgt.appendChild(footer);
    }
  },
  renderUserReports(tgt, rows) {
    const badgeClass = st => {
      const k = (st || "").toLowerCase();
      const map = {
        "new": "border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200",
        "assigned": "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-700 dark:bg-amber-900/40 dark:text-amber-200",
        "in_progress": "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-700 dark:bg-sky-900/40 dark:text-sky-200",
        "resolved": "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200"
      };
      return map[k] || map.new;
    };

    const list = document.createElement("div");
    list.className = "space-y-3 p-4";

    const allRows = (Reports._userRows && Reports._userRows.length) ? Reports._userRows : rows || [];
    const limit = Math.max(1, Reports._userLimit || allRows.length);
    const visible = allRows.slice(0, limit);

    visible.forEach(r => {
      const card = document.createElement("div");
      card.className = "flex flex-col gap-3 rounded-xl border border-slate-200 bg-white/80 p-4 shadow-sm md:flex-row md:items-center md:justify-between dark:border-slate-800 dark:bg-slate-950/70";

      const left = document.createElement("div");
      left.className = "min-w-0";

      const title = document.createElement("div");
      title.className = "font-semibold text-slate-900 dark:text-slate-100";
      title.textContent = r.title || "Untitled report";

      const desc = document.createElement("div");
      desc.className = "mt-1 clamp-2 text-xs text-slate-500 dark:text-slate-400";
      desc.textContent = r.desc || "No description";

      const chips = document.createElement("div");
      chips.className = "mt-2 flex flex-wrap items-center gap-2 text-xs";

      const idFull = String(r.id ?? "");
      const idShort = idFull.length > 10 ? `${idFull.slice(0, 6)}...${idFull.slice(-4)}` : idFull;
      const idChip = document.createElement("span");
      idChip.className = "report-chip";
      idChip.textContent = `ID: ${idShort || "-"}`;
      if (idFull) idChip.title = idFull;

      const statusChip = document.createElement("span");
      statusChip.className = `inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${badgeClass(r.status)}`;
      statusChip.textContent = r.status || "NEW";

      const timeChip = document.createElement("span");
      timeChip.className = "report-chip";
      const rawTime = r.updatedAt || r.createdAt;
      if (rawTime) {
        const d = new Date(rawTime);
        timeChip.textContent = Number.isNaN(d.getTime()) ? "Updated: -" : `Updated: ${d.toLocaleDateString()}`;
      } else {
        timeChip.textContent = "Updated: -";
      }

      chips.appendChild(statusChip);
      chips.appendChild(idChip);
      chips.appendChild(timeChip);

      left.appendChild(title);
      left.appendChild(desc);
      left.appendChild(chips);

      const right = document.createElement("div");
      right.className = "flex items-center gap-2";
      const btn = document.createElement("button");
      btn.className = "inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white shadow-sm transition hover:-translate-y-0.5 hover:bg-slate-800 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-100";
      btn.innerHTML = "<i class=\"ri-eye-line\"></i>View report";
      btn.addEventListener("click", () => UI.openReportModal(r));
      right.appendChild(btn);

      card.appendChild(left);
      card.appendChild(right);
      list.appendChild(card);
    });

    tgt.appendChild(list);

    if (allRows.length > limit) {
      const footer = document.createElement("div");
      footer.className = "mt-3 flex flex-wrap items-center justify-between gap-2 px-4 pb-4";
      const meta = document.createElement("div");
      meta.className = "text-xs text-slate-500 dark:text-slate-400";
      meta.textContent = `Showing ${visible.length} of ${allRows.length} reports`;
      const btn = document.createElement("button");
      btn.className = "inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-sm transition hover:-translate-y-0.5 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800";
      btn.innerHTML = "<i class=\"ri-more-line\"></i>Load more";
      btn.addEventListener("click", () => {
        Reports._userLimit = Math.min(allRows.length, limit + Reports._userStep);
        UI.renderTable("#userReports", allRows);
      });
      footer.appendChild(meta);
      footer.appendChild(btn);
      tgt.appendChild(footer);
    }
  },

  /* -------- Map Picker (Leaflet) -------- */
  openMapPicker() {
    const modal = $("#mapModal");
    const card = $("#mapModalCard");
    if (!modal || !card) return;
    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("overflow-hidden");
    requestAnimationFrame(() => {
      modal.classList.remove("opacity-0");
      modal.classList.add("opacity-100");
      card.classList.remove("opacity-0", "scale-95");
      card.classList.add("opacity-100", "scale-100");
    });

    if (!this._map) {
      try {
        this._map = L.map("map", { zoomControl: true, attributionControl: false }).setView([12.9716, 77.5946], 13);
        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(this._map);
        this._marker = L.marker([12.9716, 77.5946], { draggable: true }).addTo(this._map);

        const updateLatLng = (latlng) => {
          $("#mapLat").textContent = latlng.lat.toFixed(6);
          $("#mapLng").textContent = latlng.lng.toFixed(6);
          this._marker.setLatLng(latlng);
        };

        this._map.on("click", e => updateLatLng(e.latlng));
        this._marker.on("dragend", e => updateLatLng(e.target.getLatLng()));

        // seed display
        $("#mapLat").textContent = "12.971600";
        $("#mapLng").textContent = "77.594600";
      } catch (e) {
        toast("Map failed to load. Enter coordinates manually.");
      }
    }
    setTimeout(() => this._map?.invalidateSize(), 100);
  },

  mapPickSet([lat, lng], pan = false) {
    if (!this._map || !this._marker) return;
    const ll = { lat, lng };
    this._marker.setLatLng(ll);
    if (pan) this._map.setView(ll, 16);
    $("#mapLat").textContent = Number(lat).toFixed(6);
    $("#mapLng").textContent = Number(lng).toFixed(6);
  },

  confirmMapPicker() {
    const lat = parseFloat($("#mapLat").textContent);
    const lng = parseFloat($("#mapLng").textContent);
    if (Number.isNaN(lat) || Number.isNaN(lng)) return this.closeMapPicker();
    $("#rLat").value = lat.toFixed(6);
    $("#rLng").value = lng.toFixed(6);
    reverseGeocode(lat, lng).then(addr=>{ window.__geoAddr = addr || null; UI.setAddress(addr); });
    const map = document.getElementById('map');
    if (map && !this.fx.reduce()) {
      map.classList.remove('map-pulse');
      requestAnimationFrame(() => map.classList.add('map-pulse'));
      setTimeout(() => map.classList.remove('map-pulse'), 320);
    }
    this.closeMapPicker();
  },

  closeMapPicker() {
    const modal = $("#mapModal");
    const card = $("#mapModalCard");
    if (!modal || !card) return;
    card.classList.add("opacity-0", "scale-95");
    card.classList.remove("opacity-100", "scale-100");
    modal.classList.remove("opacity-100");
    modal.classList.add("opacity-0");
    modal.setAttribute("aria-hidden", "true");
    setTimeout(() => modal.classList.add("hidden"), 200);
  },

  /* -------- Photo Modal -------- */
  openPhotoModal(src) {
    const modal = $("#photoModal");
    const card = $("#photoModalCard");
    const img = $("#photoModalImg");
    if (!modal || !card || !img) return;
    img.src = src;
    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");
    requestAnimationFrame(() => {
      modal.classList.remove("opacity-0");
      modal.classList.add("opacity-100");
      card.classList.remove("opacity-0", "scale-95");
      card.classList.add("opacity-100", "scale-100");
    });
  },

  closePhotoModal() {
    const modal = $("#photoModal");
    const card = $("#photoModalCard");
    const img = $("#photoModalImg");
    if (!modal || !card || !img) return;
    card.classList.add("opacity-0", "scale-95");
    card.classList.remove("opacity-100", "scale-100");
    modal.classList.remove("opacity-100");
    modal.classList.add("opacity-0");
    modal.setAttribute("aria-hidden", "true");
    setTimeout(() => {
      modal.classList.add("hidden");
      img.removeAttribute("src");
    }, 200);
  },

  /* -------- Report Modal -------- */
  openReportModal(r) {
    const modal = $("#reportModal");
    const card = $("#reportModalCard");
    if (!modal || !card) return;

    const title = $("#reportModalTitle");
    const meta = $("#reportModalMeta");
    const reporter = $("#reportModalReporter");
    const desc = $("#reportModalDesc");
    const status = $("#reportModalStatus");
    const waste = $("#reportModalWaste");
    const auto = $("#reportModalAuto");
    const assigned = $("#reportModalAssigned");
    const assignSource = $("#reportModalAssignSource");
    const roleHint = $("#reportModalRoleHint");
    const loc = $("#reportModalLocation");
    const addr = $("#reportModalAddress");
    const created = $("#reportModalCreated");
    const updated = $("#reportModalUpdated");
    const photo = $("#reportModalPhoto");
    const proof = $("#reportModalProof");
    const events = $("#reportModalEvents");

    if (title) title.textContent = r.title || "Report";
    if (meta) meta.textContent = `ID: ${r.id || "-"}`;
    if (reporter) {
      const name = r.user?.name || r.userName || r.reporterName;
      reporter.textContent = name ? `Reporter: ${name}` : "";
    }
    if (desc) desc.textContent = r.desc || "No description";

    if (status) {
      status.textContent = "";
      const chip = document.createElement("span");
      const k = (r.status || "").toLowerCase();
      const map = {
        "new": "border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200",
        "assigned": "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-700 dark:bg-amber-900/40 dark:text-amber-200",
        "in_progress": "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-700 dark:bg-sky-900/40 dark:text-sky-200",
        "resolved": "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200",
        "queued": "border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-200"
      };
      chip.className = `inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${map[k] || map.new}`;
      chip.textContent = r.status || "NEW";
      status.appendChild(chip);
    }

    if (assigned) {
      const vendorId = r.assignedVendorId || r.vendorId || "";
      const vendorName = (window.Vendors && Vendors.cache || []).find(v => v.id === vendorId)?.name;
      const vendorType = (window.Vendors && Vendors.cache || []).find(v => v.id === vendorId)?.wasteType;
      if (vendorId) {
        const tag = vendorType ? ` (${vendorType})` : "";
        assigned.textContent = vendorName ? `${vendorName}${tag}` : `Vendor ID: ${vendorId}`;
      } else {
        assigned.textContent = "Not assigned yet";
      }
    }

    if (assignSource) {
      const src = r.autoAssigned ? "Auto-assigned (AI)" : "Manual / Admin";
      assignSource.textContent = src;
    }

    if (waste) {
      if (r.wasteType) {
        const pct = r.wasteConfidence != null ? Math.round(Number(r.wasteConfidence) * 100) : null;
        waste.textContent = pct != null ? `${r.wasteType} (${pct}%)` : r.wasteType;
      } else {
        waste.textContent = "Not detected";
      }
    }

    if (auto) {
      auto.textContent = "";
      auto.className = "mt-2";
      if (r.autoAssignNote) {
        auto.textContent = r.autoAssignNote;
        auto.className = "mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-900/40 dark:text-amber-200";
      }
    }

    if (roleHint) {
      const role = Session?.data?.role || "";
      if (role === "user") {
        roleHint.textContent = "You will see status updates here. If it stays NEW, it is waiting for admin assignment.";
      } else if (role === "vendor") {
        roleHint.textContent = "Complete the task and upload proof once finished. Status will update to RESOLVED.";
      } else if (role === "admin") {
        roleHint.textContent = "You can reassign the vendor or update status anytime from the admin dashboard.";
      } else {
        roleHint.textContent = "";
      }
    }

    const lat = Number(r.lat);
    const lng = Number(r.lng);
    const latText = Number.isFinite(lat) ? lat.toFixed(6) : "-";
    const lngText = Number.isFinite(lng) ? lng.toFixed(6) : "-";
    if (loc) loc.textContent = `${latText}, ${lngText}`;
    if (addr) addr.textContent = r.address || "";

    const c = r.createdAt ? new Date(r.createdAt) : null;
    const u = r.updatedAt ? new Date(r.updatedAt) : null;
    if (created) created.textContent = c && !Number.isNaN(c.getTime()) ? c.toLocaleString() : "-";
    if (updated) updated.textContent = u && !Number.isNaN(u.getTime()) ? u.toLocaleString() : "-";

    if (photo) {
      photo.textContent = "";
      if (r.photoBase64 && /^data:image\//i.test(r.photoBase64)) {
        const img = document.createElement("img");
        img.src = r.photoBase64;
        img.className = "report-thumb";
        img.alt = "Report photo";
        img.addEventListener("click", () => UI.openPhotoModal(r.photoBase64));
        photo.appendChild(img);
      } else {
        photo.textContent = "No photo";
        photo.className = "text-xs text-slate-500 dark:text-slate-400";
      }
    }

    if (proof) {
      proof.textContent = "";
      if (r.vendorProofBase64 && /^data:image\//i.test(r.vendorProofBase64)) {
        const img = document.createElement("img");
        img.src = r.vendorProofBase64;
        img.className = "report-thumb";
        img.alt = "Vendor proof";
        img.addEventListener("click", () => UI.openPhotoModal(r.vendorProofBase64));
        proof.appendChild(img);
      } else {
        proof.textContent = "No proof";
        proof.className = "text-xs text-slate-500 dark:text-slate-400";
      }
    }

    if (events) {
      events.textContent = "Loading audit trail...";
      UI.loadReportEvents(r);
    }

    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("overflow-hidden");
    requestAnimationFrame(() => {
      modal.classList.remove("opacity-0");
      modal.classList.add("opacity-100");
      card.classList.remove("opacity-0", "scale-95");
      card.classList.add("opacity-100", "scale-100");
    });
  },

  async loadReportEvents(report) {
    const el = $("#reportModalEvents");
    if (!el) return;
    const reportId = typeof report === "string" ? report : report?.id;
    const status = (typeof report === "object" ? report?.status : "") || "";
    if (!reportId || String(reportId).startsWith("q_") || String(reportId).startsWith("local_") || status.toLowerCase() === "queued") {
      el.textContent = "Audit trail will appear after this report syncs online.";
      return;
    }
    el.textContent = "Loading audit trail...";
    try {
      const events = await api(`/reports/${encodeURIComponent(reportId)}/events`, "GET", null, {
        cacheKey: `report.events.${reportId}`,
        cacheMaxAgeMs: 5 * 60 * 1000
      });
      if (api.lastFromCache) notifyOffline("Offline. Showing cached audit trail.");
      el.textContent = "";
      if (!events || !events.length) {
        el.textContent = "No audit events yet.";
        return;
      }
      events.forEach(ev => {
        const row = document.createElement("div");
        row.className = "flex items-start gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-800 dark:bg-slate-950";

        const dot = document.createElement("span");
        dot.className = "mt-1 h-2 w-2 rounded-full bg-emerald-500/80 flex-shrink-0";

        const body = document.createElement("div");
        body.className = "min-w-0";

        const title = document.createElement("div");
        title.className = "text-xs font-semibold text-slate-700 dark:text-slate-200";
        title.textContent = ev.message || ev.type || "Event";

        const meta = document.createElement("div");
        meta.className = "text-[11px] text-slate-500 dark:text-slate-400";
        const when = ev.createdAt ? new Date(ev.createdAt) : null;
        const whenText = when && !Number.isNaN(when.getTime()) ? when.toLocaleString() : "";
        const actor = ev.actorRole ? `${ev.actorRole}${ev.actorId ? `:${ev.actorId}` : ""}` : "";
        meta.textContent = [whenText, actor].filter(Boolean).join(" | ");

        body.appendChild(title);
        body.appendChild(meta);
        row.appendChild(dot);
        row.appendChild(body);
        el.appendChild(row);
      });
    } catch (e) {
      el.textContent = navigator.onLine ? "Failed to load audit trail." : "Offline. Audit trail unavailable.";
    }
  },

  closeReportModal() {
    const modal = $("#reportModal");
    const card = $("#reportModalCard");
    if (!modal || !card) return;
    card.classList.add("opacity-0", "scale-95");
    card.classList.remove("opacity-100", "scale-100");
    modal.classList.remove("opacity-100");
    modal.classList.add("opacity-0");
    modal.setAttribute("aria-hidden", "true");
    setTimeout(() => {
      modal.classList.add("hidden");
      document.body.classList.remove("overflow-hidden");
    }, 200);
  }
};

// Map zoom controls (optional)
UI.zoomInMap = function(){ try{ UI._map?.zoomIn?.(); }catch(_){} };
UI.zoomOutMap = function(){ try{ UI._map?.zoomOut?.(); }catch(_){} };

/* Network status + auto sync */
const Net = {
  init() {
    updateNetStatus();
    UI.renderSyncMeta();
    UI.renderOfflineResume();
    if (navigator.onLine) OfflineQueue.flush();
    window.addEventListener("online", () => {
      updateNetStatus();
      UI.renderSyncMeta();
      UI.renderOfflineResume();
      OfflineQueue.flush();
    });
    window.addEventListener("offline", () => {
      updateNetStatus();
      UI.renderSyncMeta();
      UI.renderOfflineResume();
    });
  }
};

/* Photo preview */
$("#rPhoto")?.addEventListener("change", e => {
  const f = e.target.files?.[0];
  const img = $("#rPreview");
  if (!f) { img.classList.add("hidden"); return; }
  img.src = URL.createObjectURL(f); img.classList.remove("hidden");
});

// Keep offline resume list updated while user is on auth screen
["#uLoginEmail", "#vId", "#aEmail"].forEach((sel) => {
  const el = document.querySelector(sel);
  el?.addEventListener("input", () => UI.renderOfflineResume());
});

/* Boot */
Net.init();
UI.sync(); UI.route();
// Toggles: theme + density
UI.bindToggles = function(){
  const root = document.documentElement;
  const body = document.body;
  const theme = Store.get('theme','auto');
  const density = Store.get('density','normal');

  if (density === 'compact') body.classList.add('density-compact');

  const themeBtn = document.getElementById('themeToggle');
  const themeIcon = themeBtn?.querySelector('i');
  const setThemeIcon = (mode, prefersDark = false) => {
    if (!themeIcon) return;
    if (mode === 'dark') themeIcon.className = 'ri-sun-line';
    else if (mode === 'light') themeIcon.className = 'ri-moon-line';
    else themeIcon.className = prefersDark ? 'ri-contrast-2-line' : 'ri-contrast-line';
  };

  const applyTheme = (mode) => {
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const shouldDark = mode === 'dark' ? true : mode === 'light' ? false : prefersDark;
    root.classList.toggle('dark', shouldDark);
    body.classList.toggle('dark', shouldDark);
    root.setAttribute('data-theme', mode);
    setThemeIcon(mode, prefersDark);
    nativeLog(`theme applied: ${mode} (dark=${shouldDark}) html=${root.className} body=${body.className}`);
  };

  applyTheme(theme);

  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      const mode = Store.get('theme','auto');
      if (mode !== 'dark') applyTheme('auto');
    };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }

  UI.toggleTheme = () => {
    const current = Store.get('theme','auto');
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const next =
      current === 'auto' ? (prefersDark ? 'light' : 'dark') :
      current === 'dark' ? 'light' : 'auto';
    Store.set('theme', next);
    applyTheme(next);
  };

  themeBtn?.addEventListener('click', () => nativeLog('theme toggle clicked'));
  themeBtn?.addEventListener('click', UI.toggleTheme);

  UI.toggleDensity = () => {
    const isCompact = body.classList.toggle('density-compact');
    Store.set('density', isCompact ? 'compact' : 'normal');
    nativeLog(`density=${isCompact ? 'compact' : 'normal'}`);
  };

  const densityBtn = document.getElementById('densityToggle');
  densityBtn?.addEventListener('click', () => nativeLog('density toggle clicked'));
  densityBtn?.addEventListener('click', UI.toggleDensity);
};
UI.bindToggles();

// Expose globals for inline handlers (WebView global scope)
try {
  window.UI = UI;
  window.Auth = Auth;
  window.Reports = Reports;
  window.Vendors = Vendors;
  window.OfflineQueue = OfflineQueue;
} catch (_) {}
