import express from "express";
import pg from "pg";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { Pool } = pg;
const app = express();
const port = process.env.PORT || 3000;
const here = path.dirname(fileURLToPath(import.meta.url));

app.use(express.json());
app.use(express.static(path.join(here, "public")));

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
}

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