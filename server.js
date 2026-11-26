import express from "express";
import pg from "pg";
import path from "node:path";
import fs from "node:fs";
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
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  const { rows: recipeCount } = await pool.query("SELECT COUNT(*)::int AS count FROM recipes");
  if (recipeCount[0].count === 0) {
    const seedRecipes = JSON.parse(fs.readFileSync(path.join(here, "recipes.json"), "utf8"));
    for (const recipe of seedRecipes) {
      await pool.query(
        `INSERT INTO recipes
          (id, name, category, time, level, emoji, calories, protein, image_query, ingredients, instructions, tags, servings)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13)`,
        [recipe.id, recipe.name, recipe.category, recipe.time, recipe.level, recipe.emoji,
         recipe.calories, recipe.protein, recipe.imageQuery || "",
         JSON.stringify(recipe.ingredients), JSON.stringify(recipe.instructions),
         JSON.stringify(recipe.tags || []), recipe.servings || 2]
      );
    }
    console.log("Seeded " + seedRecipes.length + " recipes into PostgreSQL");
  }
}


app.get("/api/recipes", async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Tarif veritabanı bağlı değil." });
  try {
    const params = [];
    const where = [];
    if (req.query.category && req.query.category !== "all") { params.push(String(req.query.category)); where.push("category = $" + params.length); }
    if (req.query.q) { params.push("%" + String(req.query.q).trim() + "%"); where.push("(name ILIKE $" + params.length + " OR category ILIKE $" + params.length + " OR tags::text ILIKE $" + params.length + ")"); }
    const sql = "SELECT id, name, category, time, level, emoji, calories, protein, image_query AS \"imageQuery\", ingredients, instructions, tags, servings FROM recipes " + (where.length ? "WHERE " + where.join(" AND ") : "") + " ORDER BY id";
    const { rows } = await pool.query(sql, params);
    res.set("Cache-Control", "no-store"); res.json(rows);
  } catch (error) { console.error("Recipes API error:", error); res.status(500).json({ error: "Tarifler alınamadı." }); }
});

app.get("/api/recipes/:id", async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Tarif veritabanı bağlı değil." });
  try {
    const { rows } = await pool.query("SELECT id, name, category, time, level, emoji, calories, protein, image_query AS \"imageQuery\", ingredients, instructions, tags, servings FROM recipes WHERE id = $1", [Number(req.params.id)]);
    if (!rows.length) return res.status(404).json({ error: "Tarif bulunamadı." });
    res.set("Cache-Control", "no-store"); res.json(rows[0]);
  } catch (error) { console.error("Recipe detail API error:", error); res.status(500).json({ error: "Tarif detayı alınamadı." }); }
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
      "SELECT id, ingredient, quantity, aisle, checked FROM shopping_items ORDER BY aisle, ingredient"
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
        "INSERT INTO shopping_items (ingredient, quantity, aisle, checked) VALUES ($1, $2, $3, $4)",
        [item.ingredient, item.quantity ?? "", item.aisle ?? "Diğer", Boolean(item.checked)]
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

initializeDatabase()
  .then(() => app.listen(port, () => console.log(`Menu planner listening on ${port}`)))
  .catch(error => {
    console.error("Database initialization failed:", error);
    process.exit(1);
  });