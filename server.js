import express from "express";
import pg from "pg";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { Pool } = pg;
const app = express();
const port = process.env.PORT || 3000;
const here = path.dirname(fileURLToPath(import.meta.url));

app.use(express.json());
app.use(express.static(path.join(here, "public"), {
  etag: false,
  lastModified: false,
  setHeaders(res, filePath) {
    if (filePath.endsWith(".html") || filePath.endsWith(".json")) {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
    }
  }
}));

let pool;
if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false }
  });
}

async function initializeDatabase() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS recipes (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL,
      time TEXT NOT NULL,
      level TEXT NOT NULL,
      emoji TEXT NOT NULL,
      calories INTEGER NOT NULL DEFAULT 0,
      protein INTEGER NOT NULL DEFAULT 0,
      image_query TEXT NOT NULL DEFAULT '',
      ingredients JSONB NOT NULL DEFAULT '[]'::jsonb,
      instructions JSONB NOT NULL DEFAULT '[]'::jsonb,
      tags JSONB NOT NULL DEFAULT '[]'::jsonb,
      servings INTEGER NOT NULL DEFAULT 2,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS api_recipes (
      id BIGSERIAL PRIMARY KEY, external_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'Ana yemek', time TEXT NOT NULL DEFAULT 'Belirtilmemiş',
      level TEXT NOT NULL DEFAULT 'Belirtilmemiş', emoji TEXT NOT NULL DEFAULT '🍽️',
      calories INTEGER NOT NULL DEFAULT 0, protein INTEGER NOT NULL DEFAULT 0, image_query TEXT NOT NULL DEFAULT '',
      ingredients JSONB NOT NULL DEFAULT '[]'::jsonb, instructions JSONB NOT NULL DEFAULT '[]'::jsonb,
      tags JSONB NOT NULL DEFAULT '[]'::jsonb, servings INTEGER NOT NULL DEFAULT 2,
      raw_data JSONB NOT NULL, translated_data JSONB NOT NULL DEFAULT '{}'::jsonb,
      cached_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS recipe_translations (
      source_text TEXT PRIMARY KEY, translated_text TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS weekly_menus (
      id BIGSERIAL PRIMARY KEY,
      menu_date DATE NOT NULL UNIQUE,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS shopping_items (
      id BIGSERIAL PRIMARY KEY,
      ingredient TEXT NOT NULL,
      quantity TEXT NOT NULL DEFAULT '',
      aisle TEXT NOT NULL DEFAULT 'Diğer',
      checked BOOLEAN NOT NULL DEFAULT FALSE,
      at_home BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query('ALTER TABLE shopping_items ADD COLUMN IF NOT EXISTS at_home BOOLEAN NOT NULL DEFAULT FALSE');

}


const tinyPlatesBase = "https://api.tinyplates.dev";
const categoryLabel = raw => {
  const values = [...(raw.courses || []), ...(raw.categories || [])].map(x => typeof x === "string" ? x : x.name || x.slug || "");
  const v = values.join(" ").toLowerCase();
  if (/soup|çorba/.test(v)) return "Çorba";
  if (/salad|salata/.test(v)) return "Salata";
  if (/side|garnish/.test(v)) return "Garnitür";
  if (/dessert|cake|sweet/.test(v)) return "Tatlı";
  if (/snack|appetizer|starter/.test(v)) return "Meze";
  if (/breakfast/.test(v)) return "Kahvaltı";
  return "Ana yemek";
};
const formatDuration = seconds => {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return "Belirtilmemiş";
  const mins = Math.round(n / 60);
  return mins < 60 ? mins + " dk" : Math.floor(mins / 60) + " sa " + (mins % 60 ? mins % 60 + " dk" : "");
};
const nutritionValue = value => {
  if (value == null) return 0;
  if (typeof value === "number") return Math.round(value);
  return Math.round(Number(value.value ?? value.amount ?? value.quantity ?? 0) || 0);
};
async function translateText(value) {
  const source = String(value || "").trim();
  if (!source || source.length > 480 || !pool) return source;
  try {
    const cached = await pool.query("SELECT translated_text FROM recipe_translations WHERE source_text=$1", [source]);
    if (cached.rows[0]) return cached.rows[0].translated_text;
    const url = new URL("https://api.mymemory.translated.net/get");
    url.searchParams.set("q", source);
    url.searchParams.set("langpair", "en|tr");
    if (process.env.MYMEMORY_EMAIL) url.searchParams.set("de", process.env.MYMEMORY_EMAIL);
    const response = await fetch(url, { signal: AbortSignal.timeout(9000) });
    if (!response.ok) return source;
    const data = await response.json();
    const translated = String(data.responseData?.translatedText || "").trim();
    if (!translated || data.responseStatus !== 200 || translated.toLowerCase() === source.toLowerCase()) return source;
    await pool.query("INSERT INTO recipe_translations(source_text,translated_text) VALUES($1,$2) ON CONFLICT(source_text) DO NOTHING", [source, translated]);
    return translated;
  } catch (error) {
    console.warn("Translation unavailable:", error.message);
    return source;
  }
}
function rawIngredientLine(item) {
  return item.display || item.original || item.localName || item.name || "";
}
function normalizeIngredientQuantity(name, quantity) {
  if (quantity && typeof quantity === "object") {
    const value = quantity.value ?? quantity.amount ?? "";
    const unit = quantity.unit ?? quantity.name ?? "";
    quantity = [value, unit].filter(Boolean).join(" ");
  }
  let q = String(quantity || "").trim();
  if (!q) return "";
  const norm = String(name || "").toLocaleLowerCase("tr-TR");
  const match = q.match(/^(\\d+(?:[.,]\\d+)?|½|¼|¾|\\d+\\s+\\d+\\/\\d+)\\s*(.*)$/i);
  if (!match) return q;
  const numberText = match[1].replace(",", ".");
  const amount = numberText.includes(" ") ? (() => { const [whole, frac] = numberText.split(" "); const [a,b] = frac.split("/"); return Number(whole) + Number(a)/Number(b); })()
    : ({ "½":0.5, "¼":0.25, "¾":0.75 }[numberText] ?? Number(numberText));
  if (!Number.isFinite(amount)) return q;
  const unit = match[2].toLocaleLowerCase("en-US").replace(/[._]/g, " ").trim();
  const volumeUnits = new Set(["cup","cups","c","su bardağı","su bardagi","tbsp","tablespoon","tablespoons"," yemek kaşığı","yemek kaşığı","tsp","teaspoon","teaspoons","tatlı kaşığı","çay kaşığı","ml","milliliter","milliliters","l","liter","liters"]);
  const isLiquid = /\\b(water|milk|broth|stock|oil|olive oil|vinegar|lemon juice|soy sauce|cream|juice|su|süt|yağ|sirke|limon suyu|et suyu|sebze suyu)\\b/i.test(norm);
  const cup = /^(cup|cups|c|su bardağı|su bardagi)$/.test(unit);
  const tbsp = /^(tbsp|tablespoon|tablespoons|yemek kaşığı)$/.test(unit);
  const tsp = /^(tsp|teaspoon|teaspoons|tatlı kaşığı|çay kaşığı)$/.test(unit);
  const turkishTablespoon = unit === "yemek kaşığı";
  const turkishDessert = unit === "tatlı kaşığı";
  const turkishTea = unit === "çay kaşığı";
  const mlMatch = unit.match(/^(\\d+)?\\s*(ml|milliliters?)$/);
  const lMatch = unit.match(/^(l|liter|liters)$/);
  if (cup || tbsp || tsp || turkishTablespoon || turkishDessert || turkishTea || mlMatch || lMatch) {
    const ml = amount * (cup ? 200 : (tbsp || turkishTablespoon) ? 15 : (turkishDessert) ? 10 : (tsp || turkishTea) ? 5 : mlMatch ? 1 : 1000);
    if (isLiquid || /^(water|milk|broth|stock|oil|olive oil|vinegar|lemon juice|soy sauce|cream|juice|su|süt|yağ|sirke|limon suyu|et suyu|sebze suyu)$/i.test(norm)) return `${Number(ml.toFixed(1))} ml`;
    const density = /^(flour|un)$/.test(norm) ? 0.55 : /rice|pirinç/.test(norm) ? 0.9 : /lentil|mercimek/.test(norm) ? 0.9 : /sugar|şeker/.test(norm) ? 0.85 : /yogurt|yoğurt/.test(norm) ? 1 : /butter|tereyağı/.test(norm) ? 0.95 : 0.65;
    const grams = ml * density;
    return `${Number(grams.toFixed(1))} g`;
  }
  if (/^(g|gr|gram|grams)$/.test(unit)) return `${amount} g`;
  if (/^(kg|kilogram|kilograms)$/.test(unit)) return `${amount} kg`;
  if (/^(ml|milliliter|milliliters)$/.test(unit)) return `${amount} ml`;
  if (/^(l|liter|liters)$/.test(unit)) return `${amount} ml`;
  return q;
}
function makeRecipeRecord(raw) {
  const ingredients = (raw.ingredients || []).map(x => ({
    name: x.name || x.localName || "",
    quantity: normalizeIngredientQuantity(x.name || x.localName || "", x.quantity),
    aisle: "Diğer",
    display: rawIngredientLine(x)
  }));
  const instructions = (raw.instructions || []).map(x => typeof x === "string" ? x : x.text).filter(Boolean);
  const nutrition = raw.nutrition || {};
  const totalSeconds = raw.times?.total?.seconds || raw.times?.cook?.seconds || raw.times?.prep?.seconds;
  const category = categoryLabel(raw);
  return {
    external_id: String(raw.id), name: raw.title || raw.name || "İsimsiz tarif",
    category, time: formatDuration(totalSeconds), level: "Belirtilmemiş",
    emoji: category === "Çorba" ? "🥣" : category === "Salata" ? "🥗" : category === "Meze" ? "🫒" : "🍽️",
    calories: nutritionValue(nutrition.calories), protein: nutritionValue(nutrition.protein),
    image_query: raw.title || "", ingredients, instructions,
    tags: [...new Set([...(raw.tags || []), ...(raw.cuisines || [])].map(x => typeof x === "string" ? x : x.name || "").filter(Boolean))],
    servings: raw.servings?.quantity || raw.servings?.value || 2, raw_data: raw
  };
}
async function saveApiRecipes(rawRecipes) {
  if (!pool) return [];
  const saved = [];
  for (const raw of rawRecipes) {
    if (!raw?.id) continue;
    const r = makeRecipeRecord(raw);
    const sql = "INSERT INTO api_recipes(external_id,name,category,time,level,emoji,calories,protein,image_query,ingredients,instructions,tags,servings,raw_data) " +
      "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14::jsonb) " +
      "ON CONFLICT(external_id) DO UPDATE SET name=EXCLUDED.name,category=EXCLUDED.category,time=EXCLUDED.time," +
      "calories=EXCLUDED.calories,protein=EXCLUDED.protein,ingredients=EXCLUDED.ingredients,instructions=EXCLUDED.instructions," +
      "tags=EXCLUDED.tags,servings=EXCLUDED.servings,raw_data=EXCLUDED.raw_data,updated_at=NOW() " +
      "RETURNING id,external_id,name,category,time,level,emoji,calories,protein,image_query,ingredients,instructions,tags,servings,raw_data,translated_data";
    const { rows } = await pool.query(sql, [r.external_id,r.name,r.category,r.time,r.level,r.emoji,r.calories,r.protein,r.image_query,
      JSON.stringify(r.ingredients),JSON.stringify(r.instructions),JSON.stringify(r.tags),r.servings,JSON.stringify(r.raw_data)]);
    saved.push(rows[0]);
  }
  return saved;
}
async function publicRecipe(row, detail = false) {
  const translated = row.translated_data || {};
  const name = translated.name || await translateText(row.name);
  if (!translated.name && name !== row.name) await pool.query("UPDATE api_recipes SET translated_data = translated_data || $1::jsonb WHERE id=$2", [JSON.stringify({ name }), row.id]);
  const ingredients = (row.ingredients || []).map((x, i) => ({ ...x, quantity: normalizeIngredientQuantity(x.name || x.display || "", x.quantity), display: translated.ingredients?.[i] || x.display || x.name }));
  const instructions = (row.instructions || []).map((x, i) => translated.instructions?.[i] || x);
  if (detail) {
    for (let i=0;i<ingredients.length;i++) ingredients[i].display = await translateText(ingredients[i].display);
    for (let i=0;i<instructions.length;i++) instructions[i] = await translateText(instructions[i]);
    await pool.query("UPDATE api_recipes SET translated_data=$1::jsonb WHERE id=$2", [
      JSON.stringify({ name, ingredients: ingredients.map(x => x.display), instructions }), row.id
    ]);
  }
  return {
    id: Number(row.id), externalId: row.external_id, name, category: row.category, time: row.time,
    level: row.level, emoji: row.emoji, calories: row.calories, protein: row.protein,
    imageQuery: row.image_query, ingredients: ingredients.map(x => [x.display, x.quantity || "", x.aisle || "Diğer"]),
    instructions, tags: row.tags || [], servings: row.servings, sourceUrl: row.raw_data?.url || ""
  };
}
async function tinyPlatesRequest(pathname, params = {}) {
  if (!process.env.TINY_PLATES_API_KEY) throw new Error("TINY_PLATES_API_KEY Railway değişkeni bulunamadı.");
  const url = new URL(pathname, tinyPlatesBase);
  Object.entries(params).forEach(([k,v]) => { if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v)); });
  const response = await fetch(url, {
    headers: { Authorization: "Bearer " + process.env.TINY_PLATES_API_KEY, Accept: "application/json" },
    signal: AbortSignal.timeout(18000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || "Tiny Plates HTTP " + response.status);
  return data;
}
app.get("/api/recipes", async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Tarif veritabanı bağlı değil." });
  try {
    let rows = [];
    const q = String(req.query.q || "").trim();
    if (q) {
      const data = await tinyPlatesRequest("/search", { query: q, limit: 30, language: "en" });
      rows = await saveApiRecipes(data.results || []);
    } else {
      const cached = await pool.query("SELECT id FROM api_recipes ORDER BY id LIMIT 1");
      if (!cached.rows.length) {
        const data = await tinyPlatesRequest("/popular", { limit: 40, offset: 0, language: "en" });
        await saveApiRecipes(data.recipes || []);
      }
      const result = await pool.query("SELECT id,external_id,name,category,time,level,emoji,calories,protein,image_query,ingredients,instructions,tags,servings,raw_data,translated_data FROM api_recipes ORDER BY id");
      rows = result.rows;
    }
    const output = [];
    for (const row of rows) output.push(await publicRecipe(row, false));
    res.set("Cache-Control", "no-store");
    res.json(output);
  } catch (error) {
    console.error("Tiny Plates recipe list error:", error);
    res.status(502).json({ error: error.message || "Tarif servisine ulaşılamadı." });
  }
});
app.get("/api/recipes/:id", async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Tarif veritabanı bağlı değil." });
  try {
    const { rows } = await pool.query("SELECT id,external_id,name,category,time,level,emoji,calories,protein,image_query,ingredients,instructions,tags,servings,raw_data,translated_data FROM api_recipes WHERE id=$1", [Number(req.params.id)]);
    if (!rows.length) return res.status(404).json({ error: "Tarif bulunamadı." });
    res.set("Cache-Control", "no-store");
    res.json(await publicRecipe(rows[0], true));
  } catch (error) {
    console.error("Recipe detail API error:", error);
    res.status(502).json({ error: error.message || "Tarif detayı alınamadı." });
  }
});

// Openverse: public, openly licensed image search. Results are cached in memory;
// weak title/tag matches are deliberately omitted rather than assigning a wrong dish photo.
const imageCache = new Map();
const normalizeDish = value => String(value || "").toLocaleLowerCase("tr-TR")
  .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .replace(/ı/g, "i").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const stopWords = new Set(["turkish","traditional","food","dish","recipe","with","style","yemegi","yemek","tarifi","salatasi","corbasi"]);
function imageMatchScore(name, item) {
  const wanted = normalizeDish(name).split(" ").filter(t => t.length > 2 && !stopWords.has(t));
  const text = normalizeDish([item.title, ...(item.tags || []).map(t => typeof t === "string" ? t : t.name)].join(" "));
  if (!wanted.length || !text) return 0;
  const hits = wanted.filter(t => text.includes(t));
  const coverage = hits.length / wanted.length;
  const phrase = text.includes(normalizeDish(name)) ? 0.35 : 0;
  return Math.min(1, coverage * 0.65 + phrase);
}
app.post("/api/recipe-images", async (req, res) => {
  const names = [...new Set((Array.isArray(req.body?.names) ? req.body.names : [])
    .filter(n => typeof n === "string" && n.trim()).map(n => n.trim()))].slice(0, 120);
  if (!names.length) return res.status(400).json({ error: "Tarif adları gerekli." });
  const output = {};
  const queue = names.filter(name => !imageCache.has(name));
  let cursor = 0;
  async function worker() {
    while (cursor < queue.length) {
      const name = queue[cursor++];
      try {
        const url = new URL("https://api.openverse.org/v1/images/");
        url.searchParams.set("q", name);
        url.searchParams.set("page_size", "12");
        url.searchParams.set("mature", "false");
        url.searchParams.set("filter_dead", "true");
        const response = await fetch(url, { headers: { "User-Agent": "SofraMenuPlanner/1.0 (recipe image attribution)" }, signal: AbortSignal.timeout(12000) });
        if (!response.ok) throw new Error("Openverse HTTP " + response.status);
        const data = await response.json();
        const candidates = (data.results || []).map(item => ({ item, score: imageMatchScore(name, item) }))
          .filter(x => x.score >= 0.62 && x.item.url && x.item.foreign_landing_url)
          .sort((a,b) => b.score-a.score);
        const best = candidates[0]?.item;
        imageCache.set(name, best ? {
          url: best.url, source: best.foreign_landing_url,
          creator: best.creator || "Bilinmiyor",
          license: String(best.license || "Lisans bilgisi yok").toUpperCase() + (best.license_version ? " " + best.license_version : ""),
          score: Number(candidates[0].score.toFixed(2)),
          title: best.title || name,
          attribution: best.attribution || ""
        } : null);
      } catch (error) {
        console.warn("Openverse image lookup failed:", name, error.message);
        imageCache.set(name, null);
      }
    }
  }
  await Promise.all(Array.from({length: Math.min(3, queue.length)}, () => worker()));
  for (const name of names) output[name] = imageCache.get(name) ?? null;
  res.set("Cache-Control", "public, max-age=3600");
  res.json({ provider: "Openverse", results: output, matched: Object.values(output).filter(Boolean).length, total: names.length });
});

app.get("/api/health", async (_req, res) => {
  let database = "not-configured";
  if (pool) {
    try {
      await pool.query("SELECT 1");
      database = "connected";
    } catch {
      database = "error";
    }
  }
  res.json({ status: "ok", database });
});

app.post("/api/menus/week", async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Veritabanı henüz bağlanmadı." });
  const menus = Array.isArray(req.body?.menus) ? req.body.menus : [];
  if (menus.length !== 7 || menus.some(item => !/^\d{4}-\d{2}-\d{2}$/.test(item.date || "") || !item.payload || typeof item.payload !== "object")) {
    return res.status(400).json({ error: "Yedi günlük geçerli menü listesi gerekli." });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const item of menus) {
      await client.query(
        `INSERT INTO weekly_menus (menu_date, payload)
         VALUES ($1, $2)
         ON CONFLICT (menu_date) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()`,
        [item.date, item.payload]
      );
    }
    await client.query("COMMIT");
    res.status(201).json({ saved: menus.length });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Weekly menu save error:", error);
    res.status(500).json({ error: "Haftalık menü kaydedilemedi." });
  } finally {
    client.release();
  }
});

app.get("/api/menus", async (_req, res) => {
  if (!pool) return res.json([]);
  try {
    const { rows } = await pool.query(
      "SELECT id, menu_date, payload FROM weekly_menus ORDER BY menu_date"
    );
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Menüler alınamadı." });
  }
});

app.post("/api/menus", async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Veritabanı henüz bağlanmadı." });
  const { date, payload } = req.body ?? {};
  if (!date || !payload) return res.status(400).json({ error: "Tarih ve menü gerekli." });
  try {
    const { rows } = await pool.query(
      `INSERT INTO weekly_menus (menu_date, payload)
       VALUES ($1, $2)
       ON CONFLICT (menu_date) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()
       RETURNING id, menu_date, payload`,
      [date, payload]
    );
    res.status(201).json(rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Menü kaydedilemedi." });
  }
});

app.get("/api/shopping-list", async (_req, res) => {
  if (!pool) return res.json([]);
  try {
    const { rows } = await pool.query(
      "SELECT id, ingredient, quantity, aisle, checked, at_home FROM shopping_items ORDER BY aisle, ingredient"
    );
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Alışveriş listesi alınamadı." });
  }
});

app.post("/api/shopping-list", async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Veritabanı henüz bağlanmadı." });
  const { items } = req.body ?? {};
  if (!Array.isArray(items)) return res.status(400).json({ error: "items dizisi gerekli." });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM shopping_items");
    for (const item of items) {
      await client.query(
        "INSERT INTO shopping_items (ingredient, quantity, aisle, checked, at_home) VALUES ($1, $2, $3, $4, $5)",
        [item.ingredient, item.quantity ?? "", item.aisle ?? "Diğer", Boolean(item.checked), Boolean(item.at_home)]
      );
    }
    await client.query("COMMIT");
    res.json({ saved: items.length });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    res.status(500).json({ error: "Alışveriş listesi kaydedilemedi." });
  } finally {
    client.release();
  }
});


const marketPriceCache = new Map();
const MARKET_PRICE_API = "https://api.marketfiyati.org.tr";
const normalizeMarketName = value => String(value || "").trim();
function marketProductOffers(product) {
  const offers = Array.isArray(product?.productDepotInfoList) ? product.productDepotInfoList : [];
  return offers.map(offer => ({
    market: normalizeMarketName(offer.marketAdi),
    price: Number(offer.price),
    unitPrice: offer.unitPrice ?? offer.unitPriceValue ?? null,
    branch: offer.depotName || null,
    productId: String(product.id),
    productName: product.title,
    brand: product.brand || null,
    size: product.refinedVolumeOrWeight || product.refinedQuantityUnit || null,
    updatedAt: offer.indexTime || null
  })).filter(x => x.market && Number.isFinite(x.price) && x.price > 0);
}
async function searchMarketProduct(keyword) {
  const key = String(keyword || "").trim().toLocaleLowerCase("tr-TR");
  const cached = marketPriceCache.get(key);
  if (cached && Date.now() - cached.at < 15 * 60 * 1000) return cached.data;
  const response = await fetch(MARKET_PRICE_API + "/api/v2/search", {
    method: "POST",
    headers: { "Accept": "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ keywords: keyword, pages: 0, size: 25, order: { name: "lowest_price", type: "asc" } }),
    signal: AbortSignal.timeout(15000),
    redirect: "error"
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error("Market Fiyatı servisi HTTP " + response.status);
  const products = Array.isArray(data.content) ? data.content : [];
  const result = products.map(product => ({
    id: String(product.id),
    title: product.title || keyword,
    brand: product.brand || null,
    size: product.refinedVolumeOrWeight || product.refinedQuantityUnit || null,
    offers: marketProductOffers(product)
  })).filter(product => product.offers.length);
  const payload = { keyword, products: result, numberOfFound: Number(data.numberOfFound || products.length), retrievedAt: new Date().toISOString(), warnings: data.warnings || [] };
  marketPriceCache.set(key, { at: Date.now(), data: payload });
  return payload;
}
app.get("/api/market/status", (_req, res) => {
  res.json({ provider: "TÜBİTAK Market Fiyatı", endpoint: MARKET_PRICE_API + "/api/v2/search", locationBased: false, cacheMinutes: 15, status: "ready-to-test" });
});
app.post("/api/market/compare", async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: "Karşılaştırılacak ürün listesi boş." });
  if (items.length > 20) return res.status(400).json({ error: "Tek seferde en fazla 20 ürün karşılaştırılabilir." });
  const cleaned = items.map(item => ({ name: String(item?.name || "").trim(), quantity: String(item?.quantity || "") })).filter(item => item.name).slice(0, 20);
  if (!cleaned.length) return res.status(400).json({ error: "Geçerli ürün adı bulunamadı." });
  let cursor = 0;
  const results = new Array(cleaned.length);
  let upstreamError = null;
  async function worker() {
    while (cursor < cleaned.length) {
      const index = cursor++;
      try { results[index] = await searchMarketProduct(cleaned[index].name); }
      catch (error) { upstreamError = error; results[index] = { keyword: cleaned[index].name, products: [], error: error.message }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(2, cleaned.length) }, () => worker()));
  const found = results.reduce((n, item) => n + item.products.length, 0);
  res.set("Cache-Control", "no-store");
  if (!found && upstreamError) return res.status(502).json({
    error: "Market Fiyatı kaynağı konum bilgisi olmadan fiyat verisi döndürmedi veya şu anda erişilemiyor.",
    detail: upstreamError.message,
    locationRequired: true,
    results
  });
  res.json({ provider: "TÜBİTAK Market Fiyatı", retrievedAt: new Date().toISOString(), locationBased: false, results });
});

initializeDatabase()
  .then(() => app.listen(port, () => console.log(`Menu planner listening on ${port}`)))
  .catch(error => {
    console.error("Database initialization failed:", error);
    process.exit(1);
  });