import { useEffect, useMemo, useState } from "react";
import { initializeApp } from "firebase/app";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, collection, addDoc, updateDoc, setDoc, deleteDoc, doc, onSnapshot, serverTimestamp } from "firebase/firestore";
import { getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut } from "firebase/auth";

/* ================= 1. CONFIG ================= */
const firebaseConfig = {
  apiKey: "AIzaSyAhpupwJ06s7BmSIv0i8gGDMdDSg2Pgxcg",
  authDomain: "outfits-ad18b.firebaseapp.com",
  projectId: "outfits-ad18b",
  messagingSenderId: "704358757515",
  appId: "1:704358757515:web:f785e79688e3bca7d0108e",
};

const app = initializeApp(firebaseConfig);
// Local cache: photos (stored inside Firestore) are kept on-device, so reopening the app is fast and uses far fewer reads.
const db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
const auth = getAuth(app);

/* ================= 2. CONSTANTS ================= */
const CATEGORIES = ["Top", "Bottom", "Full-Body/Dress", "Outerwear", "Shoes", "Accessory"];
const SEASONS = ["Spring", "Summer", "Autumn", "Winter"];
const FORMALITY = ["Casual", "Smart Casual", "Smart"]; // ordered low → high
const SLOT_OF = { Top: "top", Bottom: "bottom", "Full-Body/Dress": "dress", Outerwear: "outerwear", Shoes: "shoes", Accessory: "accessory" };
const SLOTS = ["top", "bottom", "dress", "outerwear", "shoes", "accessory"];
const DEFAULT_REST = { top: 1, bottom: 3, dress: 1, outerwear: 5, shoes: 1, accessory: 0 }; // days "in the wash"/resting after a wear
const DEFAULT_COLORS = [
  ["Black", "#111111", "neutral"], ["White", "#f5f5f5", "neutral"], ["Grey", "#9ca3af", "neutral"], ["Navy", "#1e3a5f", "neutral"],
  ["Beige", "#d8c3a5", "neutral"], ["Brown", "#7b5436", "neutral"], ["Denim", "#4a6fa5", "neutral"],
  ["Olive", "#6b7a3a", "accent"], ["Red", "#c0392b", "accent"], ["Blue", "#2563eb", "accent"], ["Green", "#2e8b57", "accent"],
  ["Yellow", "#eab308", "accent"], ["Pink", "#ec7fa9", "accent"], ["Purple", "#7e57c2", "accent"], ["Orange", "#e67e22", "accent"],
].map(([name, hex, kind], i) => ({ id: "c" + i, name, hex, kind }));

/* ================= 3. HELPERS ================= */
const todayStr = () => new Date().toLocaleDateString("sv");
const addDays = (d, n) => { const x = new Date(d + "T12:00:00"); x.setDate(x.getDate() + n); return x.toLocaleDateString("sv"); };
const dayDiff = (a, b) => Math.round((new Date(a + "T12:00:00") - new Date(b + "T12:00:00")) / 864e5);
const startOfWeek = (d) => addDays(d, -((new Date(d + "T12:00:00").getDay() + 6) % 7));
const uid8 = () => Math.random().toString(36).slice(2, 10);

// Photos are shrunk in the browser and stored as text inside the Firestore item (limit 1 MiB per document; we aim for ~80 KB).
function compressImage(file, max = 800) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let size = max, q = 0.75;
      for (let tries = 0; tries < 6; tries++) {
        const s = Math.min(1, size / Math.max(img.width, img.height));
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(img.width * s)); c.height = Math.max(1, Math.round(img.height * s));
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        const url = c.toDataURL("image/jpeg", q);
        if (url.length < 400_000) return resolve(url);   // ~300 KB cap, well under Firestore's 1 MiB
        size *= 0.8; q = Math.max(0.5, q - 0.05);
      }
      reject(new Error("Photo is too large to store – try a smaller one"));
    };
    img.onerror = () => reject(new Error("Could not read image"));
    img.src = URL.createObjectURL(file);
  });
}

// Availability: after a wear, a piece rests N days (washing). Looks at both past wears and future plans.
function availableOn(item, date, uses, rest) {
  const n = rest[SLOT_OF[item.category]] ?? 0;
  return !(uses[item.id] || []).some((e) => e !== date && Math.abs(dayDiff(date, e)) <= n);
}

// Formality: exact level preferred (x3); neighbouring level allowed (x1) unless "strict".
const formalWeight = (it, t, strict) => {
  const idx = it.formality.map((f) => FORMALITY.indexOf(f)).filter((i) => i >= 0);
  if (!idx.length) return 0;
  const d = Math.min(...idx.map((i) => Math.abs(i - t)));
  return d === 0 ? 3 : d === 1 && !strict ? 1 : 0;
};

const hue = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (!d) return 0;
  const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
};
function colourScore(pieces, colors) {
  const cs = pieces.map((p) => colors[p.colorId]).filter(Boolean);
  const accents = [...new Set(cs.filter((c) => c.kind === "accent").map((c) => c.hex))];
  let s = 0;
  if (accents.length === 1) s += 1.5;                       // one pop of colour on neutrals
  if (accents.length === 2) {
    const d = Math.abs(hue(accents[0]) - hue(accents[1])), dd = Math.min(d, 360 - d);
    s += dd < 35 || Math.abs(dd - 180) < 25 ? 1 : -4;       // analogous or complementary OK
  }
  if (accents.length > 2) s -= 6 * (accents.length - 2);
  if (!accents.length && cs.length >= 3) s += 0.5;
  return s;
}

const weightedPick = (arr, wf) => {
  if (!arr.length) return null;
  const ws = arr.map(wf);
  let r = Math.random() * ws.reduce((a, b) => a + b, 0);
  for (let i = 0; i < arr.length; i++) { r -= ws[i]; if (r <= 0) return arr[i]; }
  return arr[arr.length - 1];
};

function buildOnce(c) {
  const by = (s) => c.pool.filter((i) => SLOT_OF[i.category] === s);
  const has = (s) => c.locked[s] && c.outfit[s];
  const w = (it) => formalWeight(it, c.tIdx, c.strict) * (1 + Math.min(30, it.daysSince ?? 30) / 30); // favour rarely-worn
  const roll = (s) => (has(s) ? c.outfit[s] : weightedPick(by(s), w));
  const o = {};
  const mode = has("dress") ? "dress" : has("top") || has("bottom") ? "sep"
    : by("dress").length && (!by("top").length || !by("bottom").length || Math.random() < 0.3) ? "dress" : "sep";
  if (mode === "dress") { o.dress = roll("dress"); o.top = has("top") ? c.outfit.top : null; o.bottom = has("bottom") ? c.outfit.bottom : null; }
  else { o.top = roll("top"); o.bottom = roll("bottom"); o.dress = null; }
  o.shoes = roll("shoes");
  o.outerwear = has("outerwear") ? c.outfit.outerwear : Math.random() < c.outerProb ? weightedPick(by("outerwear"), w) : null;
  o.accessory = has("accessory") ? c.outfit.accessory : Math.random() < 0.5 ? weightedPick(by("accessory"), w) : null;
  return o;
}
function generateOutfit(c) {
  let best = null, bestScore = -Infinity;
  for (let n = 0; n < 40; n++) {
    const o = buildOnce(c);
    const pcs = SLOTS.map((s) => o[s]).filter(Boolean);
    let s = Math.random() + pcs.length * 0.2;
    if (!(o.dress || (o.top && o.bottom))) s -= 5;   // prefer complete outfits
    if (!o.shoes) s -= 2;
    if (c.matchColors) s += colourScore(pcs, c.colors);
    SLOTS.forEach((k) => { if (!c.locked[k] && c.outfit[k] && o[k]?.id === c.outfit[k].id) s -= 3; }); // make shuffle actually change
    if (s > bestScore) { best = o; bestScore = s; }
  }
  return best;
}

// Weather → season / outerwear
const seasonFromTemp = (t, date, lat) => {
  if (t <= 8) return "Winter";
  if (t >= 23) return "Summer";
  const m = new Date(date + "T12:00:00").getMonth() + 1;
  const autumnish = (lat ?? 1) >= 0 ? m >= 7 : m <= 6;
  return autumnish ? "Autumn" : "Spring";
};
const outerFromWeather = (w) => (w.max <= 12 ? 1 : w.max <= 17 ? 0.6 : w.max <= 20 ? 0.25 : 0) + (w.rain >= 50 ? 0.4 : 0);

function useForecast(loc) {
  const [f, setF] = useState({});
  useEffect(() => {
    if (!loc) return;
    fetch(`https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=14`)
      .then((r) => r.json())
      .then((j) => {
        const m = {};
        j.daily.time.forEach((t, i) => (m[t] = { max: j.daily.temperature_2m_max[i], min: j.daily.temperature_2m_min[i], rain: j.daily.precipitation_probability_max[i] ?? 0 }));
        setF(m);
      }).catch(() => {});
  }, [loc?.lat, loc?.lon]);
  return f;
}
const wText = (w) => (w ? `${Math.round(w.max)}° / ${Math.round(w.min)}° · ${w.rain}% rain` : "");

/* ================= 4. UI PARTS ================= */
const Chip = ({ active, onClick, children, disabled }) => (
  <button type="button" disabled={disabled} onClick={onClick}
    className={`px-3 py-1.5 rounded-full text-sm border whitespace-nowrap transition disabled:opacity-50 ${active ? "bg-stone-900 text-white border-stone-900" : "bg-white text-stone-700 border-stone-300 hover:border-stone-500"}`}>
    {children}
  </button>
);
const MultiSelect = ({ options, value, onChange }) => (
  <div className="flex flex-wrap gap-2">
    {options.map((o) => <Chip key={o} active={value.includes(o)} onClick={() => onChange(value.includes(o) ? value.filter((v) => v !== o) : [...value, o])}>{o}</Chip>)}
  </div>
);
const Label = ({ children }) => <label className="block text-sm font-medium text-stone-700 mb-1.5">{children}</label>;
const Dot = ({ c }) => (c ? <span title={c.name} className="inline-block w-3 h-3 rounded-full border border-stone-300 align-middle" style={{ background: c.hex }} /> : null);
const Toggle = ({ on, onChange, children }) => (
  <button type="button" onClick={() => onChange(!on)} className="flex items-center gap-2 text-sm text-stone-700">
    <span className={`w-9 h-5 rounded-full relative transition ${on ? "bg-stone-900" : "bg-stone-300"}`}>
      <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${on ? "left-[18px]" : "left-0.5"}`} />
    </span>{children}
  </button>
);
const Modal = ({ onClose, children }) => (
  <div className="fixed inset-0 z-30 bg-black/50 overflow-y-auto p-4" onClick={onClose}>
    <div className="max-w-xl mx-auto my-6" onClick={(e) => e.stopPropagation()}>{children}</div>
  </div>
);
const Input = (p) => <input {...p} className={`w-full border border-stone-300 rounded-lg px-3 py-2 bg-white ${p.className || ""}`} />;

function Login() {
  const [err, setErr] = useState("");
  async function signIn() {
    setErr("");
    try { await signInWithPopup(auth, new GoogleAuthProvider()); }
    catch (e) {
      const hints = {
        "auth/unauthorized-domain": "This website address isn't authorised yet. In Firebase: Authentication → Settings → Authorized domains → add this site's address (without https://).",
        "auth/operation-not-allowed": "Google sign-in isn't switched on. In Firebase: Authentication → Sign-in method → Google → Enable → Save.",
        "auth/popup-blocked": "Your browser blocked the sign-in pop-up. Allow pop-ups for this site and try again.",
        "auth/popup-closed-by-user": "The sign-in window was closed before finishing.",
        "auth/invalid-api-key": "The Firebase apiKey in App.jsx looks wrong.",
      };
      setErr((hints[e.code] || "Sign-in failed.") + ` (${e.code || e.message})`);
    }
  }
  return (
    <div className="min-h-screen grid place-items-center bg-stone-50 p-6">
      <div className="text-center space-y-4 max-w-sm">
        <h1 className="text-3xl font-semibold text-stone-900">My Wardrobe</h1>
        <p className="text-stone-500">Sign in to open your closet.</p>
        <button onClick={signIn} className="px-5 py-2.5 rounded-lg bg-stone-900 text-white">Sign in with Google</button>
        {err && <p className="text-sm text-red-600 text-left bg-red-50 rounded-lg p-3">{err}</p>}
      </div>
    </div>
  );
}

/* ================= 5. ITEM FORM (add + edit) ================= */
function ItemForm({ uid, item, palette, onDone }) {
  const [file, setFile] = useState(null);
  const [name, setName] = useState(item?.name || "");
  const [category, setCategory] = useState(item?.category || CATEGORIES[0]);
  const [seasons, setSeasons] = useState(item?.seasons || []);
  const [formality, setFormality] = useState(item?.formality || []);
  const [colorId, setColorId] = useState(item?.colorId || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const preview = useMemo(() => (file ? URL.createObjectURL(file) : item ? item.imageUrl : null), [file, item]);
  const valid = preview && name.trim() && seasons.length && formality.length;

  async function submit(e) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true); setErr("");
    try {
      const data = { name: name.trim(), category, seasons, formality, colorId: colorId || null };
      if (file) data.imageUrl = await compressImage(file);
      if (item) await updateDoc(doc(db, "users", uid, "items", item.id), data);
      else await addDoc(collection(db, "users", uid, "items"), { ...data, createdAt: serverTimestamp() });
      onDone();
    } catch (x) { setErr(x.message); }
    setBusy(false);
  }

  return (
    <form onSubmit={submit} className="bg-white rounded-2xl border border-stone-200 p-5 space-y-4">
      <div className="flex justify-between"><h2 className="font-semibold">{item ? "Edit item" : "Add clothing item"}</h2>
        <button type="button" onClick={onDone} className="text-stone-400">✕</button></div>
      <div className="flex gap-4 items-start">
        <label className="w-28 h-36 shrink-0 rounded-xl border-2 border-dashed border-stone-300 grid place-items-center cursor-pointer overflow-hidden text-stone-400 text-xs text-center">
          {preview ? <img src={preview} className="w-full h-full object-cover" /> : "Tap to add photo"}
          <input type="file" accept="image/*" className="hidden" onChange={(e) => setFile(e.target.files[0] || null)} />
        </label>
        <div className="flex-1 space-y-3">
          <div><Label>Name</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Navy linen shirt" /></div>
          <div><Label>Category</Label>
            <select value={category} onChange={(e) => setCategory(e.target.value)} className="w-full border border-stone-300 rounded-lg px-3 py-2 bg-white">
              {CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select></div>
        </div>
      </div>
      <div><Label>Colour {colorId && <span className="font-normal text-stone-500">· {palette.find((c) => c.id === colorId)?.name}</span>}</Label>
        <div className="flex flex-wrap gap-2">
          {palette.map((c) => (
            <button type="button" key={c.id} title={c.name} onClick={() => setColorId(colorId === c.id ? "" : c.id)}
              className={`w-8 h-8 rounded-full border-2 ${colorId === c.id ? "border-stone-900 ring-2 ring-stone-300" : "border-stone-200"}`} style={{ background: c.hex }} />
          ))}
        </div></div>
      <div><Label>Seasons</Label><MultiSelect options={SEASONS} value={seasons} onChange={setSeasons} /></div>
      <div><Label>Formality</Label><MultiSelect options={FORMALITY} value={formality} onChange={setFormality} /></div>
      {err && <p className="text-sm text-red-600">{err}</p>}
      <button disabled={!valid || busy} className="w-full py-2.5 rounded-lg bg-stone-900 text-white disabled:opacity-40">{busy ? "Saving…" : item ? "Save changes" : "Add to wardrobe"}</button>
      {item && <button type="button" onClick={async () => { if (confirm(`Delete "${item.name}"?`)) { await deleteDoc(doc(db, "users", uid, "items", item.id)); onDone(); } }}
        className="w-full text-sm text-red-600">Delete item</button>}
    </form>
  );
}

/* ================= 6. WARDROBE ================= */
function Wardrobe({ uid, items, palette, colors }) {
  const [q, setQ] = useState(""), [cat, setCat] = useState("All"), [season, setSeason] = useState(""), [formal, setFormal] = useState("");
  const [colour, setColour] = useState(""), [never, setNever] = useState(false);
  const [adding, setAdding] = useState(false), [editing, setEditing] = useState(null);
  const shown = items.filter((i) => i.name.toLowerCase().includes(q.toLowerCase()) && (cat === "All" || i.category === cat)
    && (!season || i.seasons.includes(season)) && (!formal || i.formality.includes(formal)) && (!colour || i.colorId === colour) && (!never || !i.wearCount));
  return (
    <div className="space-y-4">
      <button onClick={() => setAdding(true)} className="w-full py-2.5 rounded-lg bg-stone-900 text-white">＋ Add item</button>
      {adding && <Modal onClose={() => setAdding(false)}><ItemForm uid={uid} palette={palette} onDone={() => setAdding(false)} /></Modal>}
      {editing && <Modal onClose={() => setEditing(null)}><ItemForm uid={uid} item={editing} palette={palette} onDone={() => setEditing(null)} /></Modal>}
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your clothes…" />
      <div className="flex gap-2 overflow-x-auto pb-1">{["All", ...CATEGORIES].map((c) => <Chip key={c} active={cat === c} onClick={() => setCat(c)}>{c}</Chip>)}</div>
      <div className="grid grid-cols-3 gap-2">
        {[[season, setSeason, "Season", SEASONS], [formal, setFormal, "Formality", FORMALITY]].map(([v, set, l, o]) => (
          <select key={l} value={v} onChange={(e) => set(e.target.value)} className="border border-stone-300 rounded-lg px-2 py-2 bg-white text-sm">
            <option value="">Any {l.toLowerCase()}</option>{o.map((x) => <option key={x}>{x}</option>)}</select>))}
        <select value={colour} onChange={(e) => setColour(e.target.value)} className="border border-stone-300 rounded-lg px-2 py-2 bg-white text-sm">
          <option value="">Any colour</option>{palette.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
      </div>
      <Toggle on={never} onChange={setNever}>Only never-worn items</Toggle>
      {!shown.length && <p className="text-center text-stone-400 py-8">{items.length ? "No matches." : "Your wardrobe is empty — add your first item."}</p>}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {shown.map((i) => (
          <button key={i.id} onClick={() => setEditing(i)} className="text-left bg-white rounded-xl border border-stone-200 overflow-hidden">
            <img src={i.imageUrl} alt={i.name} className="aspect-[3/4] w-full object-cover" />
            <div className="p-2.5">
              <p className="text-sm font-medium truncate"><Dot c={colors[i.colorId]} /> {i.name}</p>
              <p className="text-xs text-stone-500">{i.category} · worn {i.wearCount}×</p>
              <p className="text-[11px] text-stone-400 mt-1">{i.seasons.join(", ")} · {i.formality.join(", ")}</p>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ================= 7. STYLIST ================= */
function Stylist({ uid, items, colors, uses, settings, forecast }) {
  const [date, setDate] = useState(todayStr());
  const [season, setSeason] = useState("Spring");
  const [formality, setFormality] = useState("Casual");
  const [strict, setStrict] = useState(false);
  const [matchColors, setMatchColors] = useState(true);
  const [useWeather, setUseWeather] = useState(true);
  const [outfit, setOutfit] = useState({});
  const [locked, setLocked] = useState({});
  const [msg, setMsg] = useState("");
  const [generated, setGenerated] = useState(false);

  const w = forecast[date];
  const auto = useWeather && w;
  const effSeason = auto ? seasonFromTemp(w.max, date, settings.location?.lat) : season;
  const outerProb = auto ? outerFromWeather(w) : { Winter: 1, Autumn: 0.8, Spring: 0.4, Summer: 0 }[season];
  const live = Object.fromEntries(SLOTS.map((s) => [s, (outfit[s] && items.find((i) => i.id === outfit[s].id)) || null]));
  const current = SLOTS.filter((s) => live[s]);

  function run(reset) {
    const lk = reset ? {} : locked;
    if (reset) setLocked({});
    const tIdx = FORMALITY.indexOf(formality);
    const pool = items.filter((i) => i.seasons.includes(effSeason) && formalWeight(i, tIdx, strict) > 0 && availableOn(i, date, uses, settings.rest));
    setOutfit(generateOutfit({ pool, outfit: reset ? {} : live, locked: lk, tIdx, strict, matchColors, colors, outerProb }));
    setGenerated(true); setMsg("");
  }
  const ids = () => current.map((s) => live[s].id);
  async function save() { await addDoc(collection(db, "users", uid, "outfits"), { itemIds: ids(), season: effSeason, formality, createdAt: serverTimestamp() }); setMsg("Outfit saved ✓"); }
  async function plan() { await setDoc(doc(db, "users", uid, "plans", date), { itemIds: ids(), worn: false }); setMsg(`Planned for ${date} ✓`); }

  return (
    <div className="space-y-5">
      <div className="bg-white rounded-2xl border border-stone-200 p-5 space-y-4">
        <div className="flex gap-3 items-end">
          <div className="flex-1"><Label>Outfit for</Label><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
          {w && <p className="text-sm text-stone-600 pb-2">{wText(w)}</p>}
        </div>
        {w && <Toggle on={useWeather} onChange={setUseWeather}>Auto season & layers from weather → <b>{effSeason}</b></Toggle>}
        <div><Label>Season</Label><div className="flex flex-wrap gap-2">
          {SEASONS.map((s) => <Chip key={s} disabled={!!auto} active={effSeason === s} onClick={() => setSeason(s)}>{s}</Chip>)}</div></div>
        <div><Label>Formality</Label><div className="flex flex-wrap gap-2">
          {FORMALITY.map((s) => <Chip key={s} active={formality === s} onClick={() => setFormality(s)}>{s}</Chip>)}</div>
          <p className="text-xs text-stone-400 mt-1.5">Prefers {formality}; also allows neighbouring levels unless strict.</p></div>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <Toggle on={strict} onChange={setStrict}>Strict formality</Toggle>
          <Toggle on={matchColors} onChange={setMatchColors}>Match colours</Toggle>
        </div>
        <div className="flex gap-2">
          <button onClick={() => run(true)} className="flex-1 py-2.5 rounded-lg bg-stone-900 text-white">Generate outfit</button>
          {generated && <button onClick={() => run(false)} className="flex-1 py-2.5 rounded-lg border border-stone-900">Shuffle unlocked</button>}
        </div>
      </div>
      {generated && !current.length && <p className="text-center text-stone-400 py-6">Nothing available for {effSeason} · {formality} on {date}. Items may be resting after wear, or need more tags.</p>}
      {current.length > 0 && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {current.map((s) => {
              const i = live[s];
              return (
                <div key={s} className={`bg-white rounded-xl overflow-hidden border-2 relative ${locked[s] ? "border-stone-900" : "border-stone-200"}`}>
                  <img src={i.imageUrl} alt={i.name} className="aspect-[3/4] w-full object-cover" />
                  <div className="p-2.5"><p className="text-sm font-medium truncate"><Dot c={colors[i.colorId]} /> {i.name}</p><p className="text-xs text-stone-500">{i.category}</p></div>
                  <button onClick={() => setLocked({ ...locked, [s]: !locked[s] })}
                    className={`absolute top-2 right-2 px-2.5 py-1 rounded-full text-xs shadow ${locked[s] ? "bg-stone-900 text-white" : "bg-white/90"}`}>{locked[s] ? "🔒 Locked" : "🔓 Lock"}</button>
                </div>
              );
            })}
          </div>
          {(!(live.dress || (live.top && live.bottom)) || !live.shoes) && (
            <p className="text-sm text-amber-700 bg-amber-50 rounded-lg p-3">
              Nothing available for: {[!(live.dress || (live.top && live.bottom)) && "a top + bottom (or dress)", !live.shoes && "shoes"].filter(Boolean).join(" and ")} — tag more items for {effSeason} · {formality}, or they may be resting after wear.
            </p>
          )}
          <div className="flex gap-2">
            <button onClick={save} className="flex-1 py-2.5 rounded-lg bg-emerald-700 text-white">♥ Save outfit</button>
            <button onClick={plan} className="flex-1 py-2.5 rounded-lg bg-sky-700 text-white">📅 Plan for {date.slice(5)}</button>
          </div>
          {msg && <p className="text-center text-sm text-emerald-700">{msg}</p>}
        </>
      )}
    </div>
  );
}

/* ================= 8. PLANNER ================= */
function Planner({ uid, items, plans, outfits, forecast, uses, settings }) {
  const [start, setStart] = useState(startOfWeek(todayStr()));
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const today = todayStr();
  const resting = items.filter((i) => !availableOn(i, today, uses, settings.rest) && (uses[i.id] || []).some((e) => e < today && dayDiff(today, e) <= (settings.rest[SLOT_OF[i.category]] ?? 0)));
  const planRef = (d) => doc(db, "users", uid, "plans", d);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <button onClick={() => setStart(addDays(start, -7))} className="px-3 py-1.5 rounded-lg border border-stone-300 bg-white">←</button>
        <button onClick={() => setStart(startOfWeek(today))} className="text-sm font-medium">{start} → {addDays(start, 6)}</button>
        <button onClick={() => setStart(addDays(start, 7))} className="px-3 py-1.5 rounded-lg border border-stone-300 bg-white">→</button>
      </div>
      <details className="bg-white rounded-xl border border-stone-200 p-3 text-sm">
        <summary className="cursor-pointer text-stone-700">🧺 Resting / in the wash today ({resting.length})</summary>
        <div className="flex gap-2 overflow-x-auto mt-3">
          {resting.map((i) => <img key={i.id} title={i.name} src={i.imageUrl} className="h-20 aspect-[3/4] object-cover rounded-lg opacity-70" />)}
          {!resting.length && <p className="text-stone-400">Nothing resting.</p>}
        </div>
      </details>
      {days.map((d) => {
        const p = plans[d];
        const pieces = (p?.itemIds || []).map((id) => items.find((i) => i.id === id)).filter(Boolean);
        const w = forecast[d];
        return (
          <div key={d} className={`bg-white rounded-2xl border p-4 ${d === today ? "border-stone-900" : "border-stone-200"}`}>
            <div className="flex justify-between items-baseline mb-2">
              <p className="font-medium">{new Date(d + "T12:00:00").toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}</p>
              <p className="text-xs text-stone-500">{wText(w)}</p>
            </div>
            {pieces.length ? (
              <>
                <div className="flex gap-2 overflow-x-auto">{pieces.map((x) => <img key={x.id} title={x.name} src={x.imageUrl} className="h-28 aspect-[3/4] object-cover rounded-lg shrink-0" />)}</div>
                <div className="flex gap-2 mt-3 text-sm">
                  <button onClick={() => updateDoc(planRef(d), { worn: !p.worn })} className={`flex-1 py-1.5 rounded-lg ${p.worn ? "bg-emerald-700 text-white" : "border border-stone-400"}`}>{p.worn ? "✓ Worn (undo)" : "Mark as worn"}</button>
                  <button onClick={() => deleteDoc(planRef(d))} className="px-3 py-1.5 rounded-lg border border-stone-300 text-red-600">Remove</button>
                </div>
              </>
            ) : (
              <select value="" onChange={(e) => { const o = outfits.find((x) => x.id === e.target.value); if (o) setDoc(planRef(d), { itemIds: o.itemIds, worn: false }); }}
                className="w-full border border-stone-300 rounded-lg px-3 py-2 bg-white text-sm text-stone-500">
                <option value="">Assign a saved outfit… (or plan from Stylist)</option>
                {outfits.map((o) => <option key={o.id} value={o.id}>{o.formality} · {o.season} · {o.itemIds.length} pieces</option>)}
              </select>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ================= 9. SAVED ================= */
function Saved({ uid, items, outfits }) {
  if (!outfits.length) return <p className="text-center text-stone-400 py-10">No saved outfits yet.</p>;
  return (
    <div className="space-y-4">
      {outfits.map((o) => (
        <div key={o.id} className="bg-white rounded-2xl border border-stone-200 p-4">
          <div className="flex justify-between items-center mb-3">
            <p className="text-sm text-stone-600">{o.season} · {o.formality}</p>
            <button onClick={() => deleteDoc(doc(db, "users", uid, "outfits", o.id))} className="text-xs text-red-600">Delete</button>
          </div>
          <div className="flex gap-2 overflow-x-auto">
            {o.itemIds.map((id) => items.find((i) => i.id === id)).filter(Boolean).map((p) => <img key={p.id} title={p.name} src={p.imageUrl} className="h-32 aspect-[3/4] object-cover rounded-lg shrink-0" />)}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ================= 10. PALETTE & SETTINGS ================= */
function PaletteTab({ uid, settings, items }) {
  const [colors, setColors] = useState(settings.colors);
  const [rest, setRest] = useState(settings.rest);
  const [city, setCity] = useState(settings.location?.city || "");
  const [msg, setMsg] = useState("");
  const save = (partial) => setDoc(doc(db, "users", uid, "settings", "main"), partial, { merge: true }).then(() => { setMsg("Saved ✓"); setTimeout(() => setMsg(""), 1500); });
  const upd = (id, patch) => setColors(colors.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  const inUse = (id) => items.filter((i) => i.colorId === id).length;
  async function findCity() {
    const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`).then((x) => x.json());
    const g = r.results?.[0];
    if (!g) return setMsg("City not found");
    setCity(`${g.name}, ${g.country}`);
    save({ location: { lat: g.latitude, lon: g.longitude, city: `${g.name}, ${g.country}` } });
  }
  return (
    <div className="space-y-6">
      <section className="bg-white rounded-2xl border border-stone-200 p-5 space-y-3">
        <h2 className="font-semibold">Colour palette</h2>
        <p className="text-xs text-stone-500">Neutrals go with everything. Accents are limited to one (or two harmonious ones) per outfit.</p>
        {colors.map((c) => (
          <div key={c.id} className="flex items-center gap-2">
            <input type="color" value={c.hex} onChange={(e) => upd(c.id, { hex: e.target.value })} className="w-9 h-9 rounded border-0 bg-transparent p-0" />
            <Input value={c.name} onChange={(e) => upd(c.id, { name: e.target.value })} />
            <button onClick={() => upd(c.id, { kind: c.kind === "neutral" ? "accent" : "neutral" })}
              className={`text-xs px-2.5 py-2 rounded-lg border w-20 ${c.kind === "accent" ? "bg-stone-900 text-white" : "bg-white"}`}>{c.kind}</button>
            <button onClick={() => (inUse(c.id) ? alert(`Used by ${inUse(c.id)} item(s) – re-tag them first.`) : setColors(colors.filter((x) => x.id !== c.id)))} className="text-stone-400 px-1">✕</button>
          </div>
        ))}
        <div className="flex gap-2">
          <button onClick={() => setColors([...colors, { id: uid8(), name: "New colour", hex: "#888888", kind: "accent" }])} className="flex-1 py-2 rounded-lg border border-stone-400 text-sm">＋ Add colour</button>
          <button onClick={() => save({ colors })} className="flex-1 py-2 rounded-lg bg-stone-900 text-white text-sm">Save palette</button>
        </div>
      </section>

      <section className="bg-white rounded-2xl border border-stone-200 p-5 space-y-3">
        <h2 className="font-semibold">Washing / rest days</h2>
        <p className="text-xs text-stone-500">After you wear a piece, it's skipped by the stylist for this many days.</p>
        <div className="grid grid-cols-2 gap-3">
          {SLOTS.map((s) => (
            <div key={s} className="flex items-center justify-between gap-2 text-sm capitalize">{s}
              <input type="number" min="0" max="30" value={rest[s]} onChange={(e) => setRest({ ...rest, [s]: Math.max(0, +e.target.value || 0) })} className="w-16 border border-stone-300 rounded-lg px-2 py-1.5" /></div>
          ))}
        </div>
        <button onClick={() => save({ rest })} className="w-full py-2 rounded-lg bg-stone-900 text-white text-sm">Save rest days</button>
      </section>

      <section className="bg-white rounded-2xl border border-stone-200 p-5 space-y-3">
        <h2 className="font-semibold">Weather location</h2>
        <div className="flex gap-2"><Input value={city} onChange={(e) => setCity(e.target.value)} placeholder="e.g. Amsterdam" />
          <button onClick={findCity} className="px-4 rounded-lg bg-stone-900 text-white text-sm">Set</button></div>
        {settings.location && <p className="text-xs text-stone-500">Using {settings.location.city} · temperatures in °C (Open-Meteo)</p>}
      </section>
      {msg && <p className="text-center text-sm text-emerald-700">{msg}</p>}
    </div>
  );
}

/* ================= 11. ROOT ================= */
export default function App() {
  const [user, setUser] = useState(undefined);
  const [tab, setTab] = useState("wardrobe");
  const [rawItems, setRawItems] = useState([]);
  const [plans, setPlans] = useState({});
  const [outfits, setOutfits] = useState([]);
  const [rawSettings, setRawSettings] = useState(null);

  useEffect(() => onAuthStateChanged(auth, setUser), []);
  useEffect(() => {
    if (!user) return;
    const u = (...p) => collection(db, "users", user.uid, ...p);
    const byNew = (a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0);
    const offs = [
      onSnapshot(u("items"), (s) => setRawItems(s.docs.map((d) => ({ id: d.id, ...d.data() })).sort(byNew))),
      onSnapshot(u("outfits"), (s) => setOutfits(s.docs.map((d) => ({ id: d.id, ...d.data() })).sort(byNew))),
      onSnapshot(u("plans"), (s) => setPlans(Object.fromEntries(s.docs.map((d) => [d.id, d.data()])))),
      onSnapshot(doc(db, "users", user.uid, "settings", "main"), (s) => setRawSettings(s.data() || {})),
    ];
    return () => offs.forEach((f) => f());
  }, [user]);

  const settings = useMemo(() => ({ colors: DEFAULT_COLORS, location: null, ...rawSettings, rest: { ...DEFAULT_REST, ...rawSettings?.rest } }), [rawSettings]);
  const colors = useMemo(() => Object.fromEntries(settings.colors.map((c) => [c.id, c])), [settings]);
  const forecast = useForecast(settings.location);
  const today = todayStr();

  const { uses, stats } = useMemo(() => {
    const uses = {}, stats = {};
    Object.entries(plans).forEach(([date, p]) => (p.itemIds || []).forEach((id) => {
      (uses[id] ||= []).push(date);
      if (p.worn) { const s = (stats[id] ||= { count: 0, last: null }); s.count++; if (!s.last || date > s.last) s.last = date; }
    }));
    return { uses, stats };
  }, [plans]);
  const items = useMemo(() => rawItems.map((i) => ({ ...i, wearCount: stats[i.id]?.count || 0, lastWorn: stats[i.id]?.last || null,
    daysSince: stats[i.id]?.last ? dayDiff(today, stats[i.id].last) : null })), [rawItems, stats, today]);

  if (user === undefined) return null;
  if (!user) return <Login />;
  if (rawSettings === null) return null;

  const tabs = [["wardrobe", "Wardrobe"], ["stylist", "Stylist"], ["planner", "Planner"], ["saved", "Saved"], ["palette", "Palette"]];
  return (
    <div className="min-h-screen bg-stone-50 text-stone-900">
      <header className="sticky top-0 z-10 bg-stone-50/90 backdrop-blur border-b border-stone-200">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between">
          <h1 className="font-semibold text-lg">My Wardrobe</h1>
          <button onClick={() => signOut(auth)} className="text-xs text-stone-500">Sign out</button>
        </div>
        <div className="max-w-3xl mx-auto px-4 pb-3 flex gap-2 overflow-x-auto">{tabs.map(([k, l]) => <Chip key={k} active={tab === k} onClick={() => setTab(k)}>{l}</Chip>)}</div>
      </header>
      <main className="max-w-3xl mx-auto px-4 py-5">
        {tab === "wardrobe" && <Wardrobe uid={user.uid} items={items} palette={settings.colors} colors={colors} />}
        {tab === "stylist" && <Stylist uid={user.uid} items={items} colors={colors} uses={uses} settings={settings} forecast={forecast} />}
        {tab === "planner" && <Planner uid={user.uid} items={items} plans={plans} outfits={outfits} forecast={forecast} uses={uses} settings={settings} />}
        {tab === "saved" && <Saved uid={user.uid} items={items} outfits={outfits} />}
        {tab === "palette" && <PaletteTab uid={user.uid} settings={settings} items={items} />}
      </main>
    </div>
  );
}
