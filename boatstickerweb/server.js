// server.js
import express from "express";
import multer from "multer";
import fetch from "node-fetch";
import FormData from "form-data";
import Stripe from "stripe";
import nodemailer from "nodemailer";
import sharp from "sharp";
import path from "path";
import fs from "fs/promises";
import cookieParser from "cookie-parser";
import crypto from "crypto";

// ==== Postgres ====
import pkg from "pg";
const { Pool } = pkg;

const {
  DATABASE_URL,

  // App + sessions
  APP_ORIGIN,
  SESSION_COOKIE_NAME = "sid",
  SESSION_SECRET = "",

  // Image gen
  REPLICATE_API_TOKEN,
  OPENAI_API_KEY,

  // Stripe
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  STRIPE_PRICE_PRO_MONTHLY, // <-- UPDATED: use this env var name

  // Email (optional; logs-only fallback if missing)
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,

  // Gooten
  GOOTEN_RECIPE_ID,
  GOOTEN_PARTNER_BILLING_KEY,
  GOOTEN_TEST_MODE,
  GOOTEN_STICKER_SKU,

  // === NEW: free plan throttling
  FREE_DAILY_LIMIT = "1",   // default: 3 per 24h
} = process.env;

const FREE_LIMIT = Math.max(parseInt(FREE_DAILY_LIMIT, 10) || 3, 1);
const isProd = process.env.NODE_ENV === "production";

// ---------- DB pool ----------
let pool = null;
let q = async () => { throw new Error("Database is not configured"); };
if (DATABASE_URL) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  q = (text, params) => pool.query(text, params);
} else {
  console.warn("⚠️ DATABASE_URL not set — DB features disabled.");
}

// ---------- Migration SQL ----------
const MIGRATION_SQL = `
DO $do$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
  EXCEPTION WHEN OTHERS THEN
    CREATE EXTENSION IF NOT EXISTS "pgcrypto";
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname='uuid_generate_v4') THEN
      CREATE OR REPLACE FUNCTION uuid_generate_v4() RETURNS uuid AS $fn$
        SELECT gen_random_uuid();
      $fn$ LANGUAGE SQL;
    END IF;
  END;
END$do$;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  email TEXT UNIQUE NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS login_tokens (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free','pro')),
  status TEXT NOT NULL DEFAULT 'inactive',
  stripe_customer_id TEXT UNIQUE,
  stripe_subscription_id TEXT UNIQUE,
  current_period_end timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS generations (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('image','sticker')),
  external_id TEXT NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, external_id)
);
`;

// ---------- App + transports ----------
const app = express();
app.set("trust proxy", 1);

// Multer
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
});

// Stripe
const stripe = new Stripe(STRIPE_SECRET_KEY);

// Nodemailer (real SMTP or logs-only fallback)
let transporter;
if (SMTP_HOST && SMTP_PORT && SMTP_USER && SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: parseInt(SMTP_PORT, 10),
    secure: SMTP_PORT === "465",
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  console.log("✉️ Using real SMTP transport");
} else {
  transporter = nodemailer.createTransport({ jsonTransport: true });
  console.log("✉️ SMTP envs missing — using JSON transport (emails printed to logs)");
}

// Static
app.use("/images", express.static(path.join(process.cwd(), "src/public/images"), { maxAge: "7d" }));
app.use(express.static("public"));
app.use(cookieParser(SESSION_SECRET || undefined));
// IMPORTANT: keep /webhook raw; everything else JSON
app.use((req, res, next) => {
  if (req.originalUrl === "/webhook") return next();
  return express.json({ limit: "2mb" })(req, res, next);
});

app.get("/me/plan", async (req, res) => {
  try {
    const user = await getAuthedUser(req);
    const plan = await getPlan(user?.id);
    res.json({ plan });
  } catch { res.json({ plan: "free" }); }
});

// Health
app.get("/healthz", async (_req, res) => {
  try {
    if (!pool) return res.status(200).send("ok (no-db)");
    await q("select 1");
    res.status(200).send("ok");
  } catch (e) {
    res.status(500).send("db not ready");
  }
});

/* ============================
   AUTH helpers
   ============================ */
async function getAuthedUser(req) {
  if (!pool) return null;
  const sid = req.signedCookies?.[SESSION_COOKIE_NAME] || req.cookies?.[SESSION_COOKIE_NAME];
  if (!sid) return null;
  const now = new Date();
  const { rows } = await q(
    `SELECT u.id, u.email
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.id = $1 AND s.expires_at > $2
     LIMIT 1`,
    [sid, now]
  );
  return rows[0] || null;
}

async function getPlan(userId) {
  if (!pool || !userId) return "free";
  const { rows } = await q(
    `SELECT plan, status
     FROM subscriptions
     WHERE user_id=$1
     ORDER BY updated_at DESC
     LIMIT 1`,
    [userId]
  );
  const s = rows[0];
  if (s && s.plan === "pro" && s.status === "active") return "pro";
  return "free";
}

/* ============================
   AUTH: magic-link endpoints
   ============================ */

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}
function newToken() {
  try { return crypto.randomBytes(32).toString("base64url"); }
  catch { return crypto.randomBytes(32).toString("hex"); }
}
function cookieOptions(days = 90) {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: isProd,
    path: "/",
    maxAge: days * 24 * 60 * 60 * 1000,
    signed: !!SESSION_SECRET,
  };
}
async function createSession(res, userId) {
  const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
  const { rows } = await q(
    "INSERT INTO sessions (user_id, expires_at) VALUES ($1,$2) RETURNING id",
    [userId, expiresAt]
  );
  const sid = rows[0].id;
  res.cookie(SESSION_COOKIE_NAME, sid, cookieOptions(90));
  return sid;
}

app.post("/auth/send-link", async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ error: "Database not configured" });
    const emailRaw = (req.body?.email || "").trim().toLowerCase();
    if (!emailRaw || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailRaw)) {
      return res.status(400).json({ error: "Valid email required" });
    }
    if (!APP_ORIGIN) return res.status(500).json({ error: "APP_ORIGIN not configured" });

    await q("INSERT INTO users (email) VALUES ($1) ON CONFLICT (email) DO NOTHING", [emailRaw]);
    const u = await q("SELECT id FROM users WHERE email=$1", [emailRaw]);
    const userId = u.rows[0].id;

    const token = newToken();
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    await q(
      "INSERT INTO login_tokens (user_id, token_hash, expires_at) VALUES ($1,$2,$3)",
      [userId, tokenHash, expiresAt]
    );

    const verifyUrl = `${APP_ORIGIN.replace(/\/+$/,'')}/auth/verify?token=${encodeURIComponent(token)}`;

    const html = `
      <div style="font-family:Arial,sans-serif;color:#222">
        <h2>Sign in to Boat2Merch</h2>
        <p>Click the secure link below to sign in. This link expires in 15 minutes.</p>
        <p><a href="${verifyUrl}" style="background:#ff9800;color:#121212;padding:10px 14px;border-radius:8px;text-decoration:none;display:inline-block">Sign in</a></p>
        <p style="color:#666">If the button doesn't work, paste this URL into your browser:</p>
        <p style="word-break:break-all;color:#555">${verifyUrl}</p>
      </div>
    `;
    await transporter.sendMail({
      from: SMTP_USER ? `"boat2merch" <${SMTP_USER}>` : "boat2merch@example.local",
      to: emailRaw,
      subject: "Your sign-in link",
      html,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("❌ /auth/send-link error:", err);
    res.status(500).json({ error: "Unable to send link" });
  }
});

app.get("/auth/verify", async (req, res) => {
  try {
    if (!pool) return res.status(500).send("Database not configured");
    const token = (req.query?.token || "").toString();
    if (!token) return res.status(400).send("Missing token");

    const tokenHash = hashToken(token);
    const now = new Date();

    const { rows } = await q(
      `SELECT lt.id, lt.user_id
       FROM login_tokens lt
       WHERE lt.token_hash = $1
         AND lt.used = false
         AND lt.expires_at > $2
       LIMIT 1`,
      [tokenHash, now]
    );
    if (!rows.length) return res.status(400).send("Invalid or expired link");

    const { user_id, id: tokenId } = rows[0];
    await q("UPDATE login_tokens SET used=true WHERE id=$1", [tokenId]);
    await createSession(res, user_id);

    const target = `${(APP_ORIGIN || "").replace(/\/+$/,'')}/index.html?login=ok`;
    res.redirect(target);
  } catch (err) {
    console.error("❌ /auth/verify error:", err);
    res.status(500).send("Auth failed");
  }
});

app.get("/auth/session", async (req, res) => {
  try {
    const user = await getAuthedUser(req);
    if (!user) return res.json({ user: null });
    return res.json({ user: { email: user.email } });
  } catch (err) {
    console.error("❌ /auth/session error:", err);
    res.status(500).json({ user: null });
  }
});

app.post("/auth/signout", async (req, res) => {
  try {
    if (pool) {
      const sid = req.signedCookies?.[SESSION_COOKIE_NAME] || req.cookies?.[SESSION_COOKIE_NAME];
      if (sid) await q("DELETE FROM sessions WHERE id=$1", [sid]).catch(() => {});
    }
    res.clearCookie(SESSION_COOKIE_NAME, cookieOptions(0));
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ /auth/signout error:", err);
    res.status(500).json({ ok: false });
  }
});

/* ============================
   IMAGE GENERATION
   ============================ */

const GOOTEN_PRODUCT_ID = "PUT_PRODUCT_ID_HERE";
const DESIRED_SIZE = "525x725";
const DESIRED_PACK = "1Pack";
const DESIRED_VARIANT = "Single";

const GPT_IMAGE_VERSION =
  "bf62744a8f9b8c5775d510ebfa7aaf11866d35afd31952f3f053218df8470e1e";

const MAX_SOURCEID_LEN = 50;
const safeSourceId = (id) => (id ? String(id).slice(0, MAX_SOURCEID_LEN) : undefined);

function normalizeCountryCode(input, fallback = "US") {
  if (!input) return fallback;
  const raw = String(input).trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(raw)) return raw;
  const MAP = { "UNITED STATES":"US","UNITED STATES OF AMERICA":"US","USA":"US","U.S.":"US","U.S.A.":"US","AMERICA":"US","CANADA":"CA" };
  return MAP[raw] || fallback;
}
function getShipCountryCode(addr) {
  const c = addr?.country || addr?.CountryCode || (typeof addr?.Country === "string" ? addr.Country : null);
  return normalizeCountryCode(c, "US");
}

const variantsCache = new Map();
const MAX_VARIANTS_BODY_BYTES = 5 * 1024 * 1024;
const DEFAULT_PAGE_SIZE = 200;

async function fetchWithSizeCap(url, capBytes = MAX_VARIANTS_BODY_BYTES) {
  const resp = await fetch(url);
  if (!resp.ok) {
    const errTxt = await resp.text();
    throw new Error(`Gooten productvariants failed: ${resp.status} ${errTxt}`);
  }
  const reader = resp.body.getReader ? resp.body.getReader() : null;
  if (!reader) {
    const txt = await resp.text();
    if (txt.length > capBytes) throw new Error(`Gooten productvariants body exceeded ${capBytes} bytes`);
    return txt;
  }
  let received = 0;
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > capBytes) {
      try { reader.cancel(); } catch {}
      throw new Error(`Gooten productvariants body exceeded ${capBytes} bytes`);
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) { merged.set(c, offset); offset += c.byteLength; }
  return new TextDecoder("utf-8").decode(merged);
}

async function fetchVariantsForCountry(countryCode) {
  if (!GOOTEN_PRODUCT_ID) throw new Error("GOOTEN_PRODUCT_ID missing.");
  if (!GOOTEN_RECIPE_ID) throw new Error("GOOTEN_RECIPE_ID missing.");

  const key = countryCode.toUpperCase();
  if (variantsCache.has(key)) return variantsCache.get(key);

  const url =
    `https://api.print.io/api/v/5/source/api/productvariants/` +
    `?recipeid=${encodeURIComponent(GOOTEN_RECIPE_ID)}` +
    `&productid=${encodeURIComponent(GOOTEN_PRODUCT_ID)}` +
    `&countrycode=${encodeURIComponent(countryCode)}` +
    `&page=1&pagesize=${DEFAULT_PAGE_SIZE}`;

  const text = await fetchWithSizeCap(url);
  let data;
  try { data = JSON.parse(text); }
  catch (e) { throw new Error(`Failed to parse productvariants JSON (${text.length} bytes): ${e.message}`); }

  const list =
    data?.ProductVariants || data?.Variants || data?.Data || data?.Items || (Array.isArray(data) ? data : []) || [];

  const enabled = list.filter((v) => {
    const enabledCountries = v?.IsEnabledIn || v?.EnabledIn || v?.AvailableIn || [];
    const flag = v?.IsEnabled === true || v?.IsEnabledInUS === true || v?.IsEnabledInCA === true;
    return flag || (Array.isArray(enabledCountries) && enabledCountries.includes(key));
  });

  const simplified = enabled
    .map((v) => ({ sku: v?.Sku || v?.SKU || "", name: v?.Name || v?.VariantName || "" }))
    .filter((v) => v.sku);

  variantsCache.set(key, simplified);
  return simplified;
}

function pickPreferredVariant(enabled, { size, pack, variant }) {
  const strict = enabled.find((v) => {
    const hay = `${v.sku} ${v.name}`;
    return hay.includes(size) && hay.includes(pack) && hay.includes(variant);
  });
  if (strict) return strict.sku;
  const bySizePack = enabled.find((v) => {
    const hay = `${v.sku} ${v.name}`;
    return hay.includes(size) && hay.includes(pack);
  });
  if (bySizePack) return bySizePack.sku;
  return enabled[0]?.sku;
}

async function pickSkuForCountry({ preferredSku, countryCode }) {
  const enabled = await fetchVariantsForCountry(countryCode);
  if (!enabled.length) throw new Error(`No enabled variants for ${countryCode}.`);
  if (preferredSku) {
    const ok = enabled.some((v) => v.sku === preferredSku);
    if (ok) return preferredSku;
    console.warn(`[Gooten] Env SKU "${preferredSku}" not enabled for ${countryCode}. Falling back.`);
  }
  const chosen = pickPreferredVariant(enabled, { size: DESIRED_SIZE, pack: DESIRED_PACK, variant: DESIRED_VARIANT });
  if (!chosen) throw new Error(`Could not pick a SKU for ${countryCode}.`);
  console.log(`[Gooten] Selected SKU for ${countryCode}: ${chosen}`);
  return chosen;
}

/* === NEW: free-plan limit check helper === */
async function assertWithinFreeLimit(userId) {
  if (!userId) return; // anonymous users aren't counted/enforced
  const plan = await getPlan(userId);
  if (plan === "pro") return;

  const { rows } = await q(
    `SELECT COUNT(*)::int AS n
     FROM generations
     WHERE user_id=$1 AND created_at > NOW() - INTERVAL '1 day'`,
    [userId]
  );
  const used = rows[0]?.n || 0;
  if (used >= FREE_LIMIT) {
    const resetIn = "24h";
    const err = new Error(`Free limit reached (${FREE_LIMIT}/24h).`);
    err.code = "FREE_LIMIT";
    err.meta = { limit: FREE_LIMIT, used, window: resetIn };
    throw err;
  }
}

app.post("/generate-image", upload.single("boatImage"), async (req, res) => {
  const t0 = Date.now();
  try {
    const user = await getAuthedUser(req);
    try { await assertWithinFreeLimit(user?.id); }
    catch (limitErr) {
      if (limitErr?.code === "FREE_LIMIT") {
        return res.status(429).json({ error: limitErr.message, ...limitErr.meta });
      }
      throw limitErr;
    }

    if (!req.file) return res.status(400).json({ error: "No file uploaded (field name must be 'boatImage')." });
    if (!REPLICATE_API_TOKEN || !OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing API credentials (REPLICATE_API_TOKEN and/or OPENAI_API_KEY)." });
    }

    const mode = (req.body?.mode || "sticker").toLowerCase();
    const isSticker = mode === "sticker";

    // === PLAN-AWARE PROMPTS ===
    const plan = await getPlan(user?.id);
    const isPro = plan === "pro";

    // Pro: keep your current rich/color prompts
    const PRO_STICKER_PROMPT =
      "Create a vibrant, vector-style illustration of the boat shown in the input image, preserving the boat’s ORIGINAL colors (hull, stripes/graphics, upholstery) and readable name/registration numbers. Simplify shapes, clean edges, and add subtle 2–3 tone cel-shading for depth. Add a thick white die-cut contour around the entire silhouette so it reads as a sticker. TRANSPARENT background. Include the entire boat with a small margin—no cropping. Remove all water, wake, reflections, and scenery. No extra elements or cast shadows outside the silhouette.";

    const PRO_IMAGE_PROMPT =
      "Create a clean, poster-style COLORED line illustration of the boat in the input image using the boat’s ORIGINAL color palette (hull/trim/decals). Use a thin dark outline with tasteful line-weight variation and minimal 1–2 tone shading for form. SOLID WHITE background. Show the entire boat with a small margin—no cropping. Exclude water, wake, reflections, people, and background scenery. No extra elements or effects.";

    // Free: black-and-white line drawing only (no color, no shading)
    const FREE_PROMPT_BASE =
      "Create a clean black-and-white line drawing of the boat in the input image. No color. Uniform thin black outline, no shading or gradients, no textures. Show the entire boat with a small margin — do not crop. Remove water, wake, reflections, people, and any background scenery. Do not add extra elements, decals, text, logos, or effects.";

    const prompt = isPro
      ? (isSticker ? PRO_STICKER_PROMPT : PRO_IMAGE_PROMPT)
      : FREE_PROMPT_BASE;

    const backgroundSetting = isSticker ? "transparent" : "opaque";

    let img = sharp(req.file.buffer).rotate()
      .resize({ width: 1280, height: 1280, fit: "inside", withoutEnlargement: true });

    const meta = await img.metadata();
    const base = Math.max(meta.width || 0, meta.height || 0) || 1024;
    const pad = Math.round(base * 0.12);

    img = img.extend({
      top: pad, bottom: pad, left: pad, right: pad,
      background: isSticker ? { r: 0, g: 0, b: 0, alpha: 0 } : "#ffffff"
    });

    const pngBuffer = await img.png({ compressionLevel: 9 }).toBuffer();
    req.file.buffer = null;

    const kb = Math.round(pngBuffer.byteLength / 1024);
    console.log(`[generate-image] plan=${plan} mode=${mode} input ~${kb}KB`);

    const dataUrl = `data:image/png;base64,${pngBuffer.toString("base64")}`;

    const makePrediction = async (imageRef) => {
      const createResp = await fetch("https://api.replicate.com/v1/predictions", {
        method: "POST",
        headers: { Authorization: `Token ${REPLICATE_API_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          version: GPT_IMAGE_VERSION,
          input: {
            input_images: [imageRef],
            image: imageRef,
            prompt,
            background: backgroundSetting,
            openai_api_key: OPENAI_API_KEY,
            quality: "auto",
            input_fidelity: "high",
            moderation: "auto",
            number_of_images: 1,
            output_format: "png",
            output_compression: 90
          }
        })
      });

      const raw = await createResp.text();
      let payload = null;
      try { payload = JSON.parse(raw); } catch {}

      if (!createResp.ok) {
        const msg = payload?.error || payload?.detail || raw?.slice(0, 1200) || "Unknown Replicate error";
        return { ok: false, code: createResp.status, payload: msg };
      }
      if (!payload?.id) return { ok: false, code: 500, payload: payload || "No prediction id" };
      return { ok: true, id: payload.id };
    };

    let pred = await makePrediction(dataUrl);

    if (!pred.ok) {
      const errText = String(pred.payload || "");
      const shouldFallback =
        pred.code >= 400 &&
        (errText.includes("data URL") || errText.includes("base64") || errText.includes("Too Large") ||
         errText.includes("payload") || errText.includes("unsupported") || errText.includes("input_images"));

      if (shouldFallback) {
        console.warn("[generate-image] data URL rejected, falling back to tmpfiles…");
        const form = new FormData();
        form.append("file", pngBuffer, { filename: "upload.png", contentType: "image/png" });

        const uploadResp = await fetch("https://tmpfiles.org/api/v1/upload", {
          method: "POST",
          body: form,
          headers: form.getHeaders(),
        });

        if (!uploadResp.ok) {
          const txt = await uploadResp.text().catch(() => "");
          return res.status(502).json({ error: `tmpfiles upload failed: ${uploadResp.status}`, details: txt.slice(0, 800) });
        }

        const uploadData = await uploadResp.json().catch(() => null);
        const rawUrl = uploadData?.data?.url;
        if (!rawUrl) return res.status(500).json({ error: "No URL returned from tmpfiles" });

        const imageUrl = rawUrl.includes("/dl/") ? rawUrl : rawUrl.replace("tmpfiles.org/", "tmpfiles.org/dl/");
        pred = await makePrediction(imageUrl);
      }
    }

    if (!pred.ok) {
      console.error("Replicate create error:", pred.code, pred.payload);
      return res.status(502).json({ error: `Replicate error ${pred.code}`, details: pred.payload });
    }

    console.log(`[generate-image] created prediction ${pred.id} in ${Date.now() - t0}ms`);
    res.json({ prediction: { id: pred.id } });
  } catch (error) {
    console.error("❌ Image generation error:", error);
    res.status(500).json({ error: error?.message || "Failed to generate image" });
  }
});

// Images list (examples page)
app.get("/images/list", async (req, res) => {
  try {
    const dir = path.join(process.cwd(), "src/public/images");
    const entries = await fs.readdir(dir, { withFileTypes: true });

    const allow = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif"]);
    const files = entries
      .filter(d => d.isFile())
      .map(d => d.name)
      .filter(name => allow.has(path.extname(name).toLowerCase()))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map(name => `/images/${name}`);

    res.json(files);
  } catch (err) {
    console.error("IMAGE LIST ERROR:", err);
    res.status(500).json({ error: "Failed to list images" });
  }
});

// Poll prediction (logs once)
app.get("/prediction-status/:id", async (req, res) => {
  try {
    const predictionId = req.params.id;
    const statusResp = await fetch(`https://api.replicate.com/v1/predictions/${predictionId}`, {
      headers: { Authorization: `Token ${REPLICATE_API_TOKEN}` },
    });

    const text = await statusResp.text();
    let statusData;
    try { statusData = JSON.parse(text); } catch { statusData = null; }

    if (!statusResp.ok) {
      return res.status(502).json({
        error: `Replicate status error ${statusResp.status}`,
        details: statusData || text?.slice(0, 800) || "No body",
      });
    }

    if (statusData?.status === "succeeded") {
      const user = await getAuthedUser(req);
      if (user) {
        const mode = (req.query?.mode || "sticker").toString().toLowerCase() === "image" ? "image" : "sticker";
        await q(
          `INSERT INTO generations (user_id, mode, external_id)
           VALUES ($1,$2,$3)
           ON CONFLICT (user_id, external_id) DO NOTHING`,
          [user.id, mode, predictionId]
        ).catch(() => {});
      }
    }

    res.json(statusData);
  } catch (error) {
    console.error("❌ Prediction status error:", error);
    res.status(500).json({ error: error?.message || "Failed to get prediction status" });
  }
});

// Gooten debug
app.get("/debug/gooten-variants", async (req, res) => {
  try {
    const country = normalizeCountryCode(req.query.country || "US");
    const enabled = await fetchVariantsForCountry(country);
    res.json({ country, enabledCount: enabled.length, enabled });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Gooten order helper
async function submitGootenOrder({ imageUrl, email, name, address, sourceId }) {
  if (!GOOTEN_RECIPE_ID || !GOOTEN_PARTNER_BILLING_KEY) {
    throw new Error("Missing Gooten recipe/billing env vars.");
  }

  const shipTo = {
    FirstName: name?.split(" ")?.[0] || "Customer",
    LastName: name?.split(" ")?.slice(1).join(" ") || " ",
    Line1: address?.line1 || "",
    Line2: address?.line2 || "",
    City: address?.city || "",
    State: address?.state || "",
    CountryCode: normalizeCountryCode(address?.country || "US"),
    PostalCode: address?.postal_code || address?.zip || "",
    Phone: address?.phone || "0000000000",
    Email: email || "unknown@example.com",
  };

  const countryCode = getShipCountryCode(shipTo);

  const sku = await pickSkuForCountry({
    preferredSku: (GOOTEN_STICKER_SKU || "").trim() || null,
    countryCode,
  });

  const safeId = safeSourceId(sourceId);

  const body = {
    ShipToAddress: shipTo,
    BillingAddress: shipTo,
    Items: [
      {
        Quantity: 1,
        SKU: sku,
        ShipType: "standard",
        Images: [{ Url: imageUrl }],
        SourceId: safeId,
      },
    ],
    Payment: { PartnerBillingKey: GOOTEN_PARTNER_BILLING_KEY },
    IsInTestMode: String(GOOTEN_TEST_MODE).toLowerCase() === "true",
    SourceId: safeId,
    IsPartnerSourceIdUnique: true,
  };

  const url = `https://api.print.io/api/v/5/source/api/orders/?recipeid=${encodeURIComponent(GOOTEN_RECIPE_ID)}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errTxt = await resp.text();
    throw new Error(`Gooten order failed: ${resp.status} ${errTxt}`);
  }

  return resp.json();
}

/* ============================
   PRO SUBSCRIPTION CHECKOUT
   ============================ */
app.post("/pro/checkout", async (req, res) => {
  try {
    const PRICE_ID = process.env.STRIPE_PRICE_PRO_MONTHLY; // uses your env var
    if (!PRICE_ID) {
      return res.status(400).json({ error: "Missing STRIPE_PRICE_PRO_MONTHLY" });
    }

    // If you have auth, attach the email so Stripe creates/links a Customer automatically
    const user = await getAuthedUser(req).catch(() => null);
    const customerEmail = user?.email || undefined;

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: PRICE_ID, quantity: 1 }],
      allow_promotion_codes: true,
      ...(customerEmail ? { customer_email: customerEmail } : {}),
      success_url: `${(APP_ORIGIN || "").replace(/\/+$/,"")}/pricing.html?pro=ok`,
      cancel_url: `${(APP_ORIGIN || "").replace(/\/+$/,"")}/pricing.html`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("❌ /pro/checkout error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Stripe: One-time Sticker Checkout Session (kept)
app.post("/create-checkout-session", async (req, res) => {
  try {
    const { email, imageUrl, name, address } = req.body;
    if (!email || !imageUrl || !name || !address) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: "Boat Sticker", images: [imageUrl] },
            unit_amount: 700,
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      customer_email: email,
      shipping_address_collection: { allowed_countries: ["US", "CA"] },
      metadata: { imageUrl, buyerName: name, buyerAddress: JSON.stringify(address) },
      success_url: `${(APP_ORIGIN || "").replace(/\/+$/,'')}/thank-you.html`,
      cancel_url: "https://boat2merch.com",
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("❌ /create-checkout-session error:", err);
    res.status(500).json({ error: err.message });
  }
});

/* ============================
   Stripe webhook:
   - Handles PRO subscriptions
   - Keeps one-time orders working
   ============================ */
app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("⚠️ Webhook signature verification failed.", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      // (A) SUBSCRIPTION checkout finished => mark PRO
      if (session.mode === "subscription") {
        const subId = session.subscription;
        const customerId = session.customer;
        const email = session.customer_details?.email || session.customer_email || null;

        if (pool && email) {
          try {
            const u = await q(
              "INSERT INTO users (email) VALUES ($1) ON CONFLICT (email) DO UPDATE SET email=EXCLUDED.email RETURNING id",
              [email]
            );
            const userId = u.rows[0].id;

            await q(`
              INSERT INTO subscriptions (user_id, plan, status, stripe_customer_id, stripe_subscription_id, current_period_end)
              VALUES ($1,'pro','active',$2,$3, to_timestamp(0))
              ON CONFLICT (stripe_subscription_id) DO UPDATE
              SET plan='pro', status='active', stripe_customer_id=$2, updated_at=now()
            `, [userId, customerId, subId]);
          } catch (e) {
            console.error("❌ failed to upsert pro sub:", e);
          }
        }
      }

      // (B) ONE-TIME payment for sticker => create order + send email
      if (session.mode === "payment") {
        const buyerEmail = session.customer_details?.email || session.customer_email || "unknown";
        const imageUrl = session.metadata?.imageUrl || "";
        const buyerName = session.metadata?.buyerName || session.customer_details?.name || "Customer";

        const shipping =
          session.shipping_details?.address ||
          (() => {
            try { return JSON.parse(session.metadata?.buyerAddress || "{}"); }
            catch { return {}; }
          })();

        try {
          const order = await submitGootenOrder({
            imageUrl,
            email: buyerEmail,
            name: buyerName,
            address: {
              line1: shipping.line1,
              line2: shipping.line2,
              city: shipping.city,
              state: shipping.state,
              country: shipping.country,
              postal_code: shipping.postal_code || shipping.zip,
              phone: session.customer_details?.phone,
            },
            sourceId: session.id,
          });
          console.log("✅ Gooten order created:", order);
        } catch (e) {
          console.error("❌ Gooten order error:", e);
        }

        try {
          const emailHtml = `
            <h2>New Sticker Order</h2>
            <p><strong>Buyer Name:</strong> ${buyerName}</p>
            <p><strong>Buyer Email:</strong> ${buyerEmail}</p>
            <p><strong>Address:</strong><br/>
              ${shipping.line1 || ""}<br/>
              ${shipping.city || ""}, ${shipping.state || ""} ${shipping.postal_code || ""}<br/>
              ${shipping.country || ""}
            </p>
            <p><strong>Sticker Image:</strong></p>
            <img src="${imageUrl}" alt="Purchased Sticker" style="max-width:300px; border:1px solid #ccc; border-radius:6px;" />
          `;
          await transporter.sendMail({
            from: SMTP_USER ? `"boat2merch" <${SMTP_USER}>` : "boat2merch@example.local",
            to: "charliebrayton8@gmail.com",
            subject: `New Sticker Order from ${buyerName}`,
            html: emailHtml,
          });
          console.log("✅ Order email sent");
        } catch (mailErr) {
          console.error("❌ Error sending order email:", mailErr);
        }
      }
    }

    // Keep subscription lifecycle in sync
    if (event.type === "customer.subscription.created" || event.type === "customer.subscription.updated") {
      const sub = event.data.object;
      await q(`
        UPDATE subscriptions
        SET status=$1, current_period_end = to_timestamp($2), updated_at=now()
        WHERE stripe_subscription_id=$3
      `, [sub.status, Math.floor(sub.current_period_end || 0), sub.id]).catch(()=>{});
    }

    if (event.type === "customer.subscription.deleted") {
      const sub = event.data.object;
      await q(`
        UPDATE subscriptions
        SET status='canceled', updated_at=now()
        WHERE stripe_subscription_id=$1
      `, [sub.id]).catch(()=>{});
    }

    res.json({ received: true });
  } catch (err) {
    console.error("❌ Webhook handler error:", err);
    res.status(500).send("Webhook processing failed");
  }
});

// ---------- BOOT ----------
async function start() {
  try {
    if (pool) {
      console.log("⛏️ Running DB migration…");
      await q(MIGRATION_SQL);
      await q("SELECT to_regclass('public.users')");
      console.log("✅ Database schema is ready");
    }

    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
  } catch (e) {
    console.error("❌ Failed to start server (migration?):", e);
    process.exit(1);
  }
}

start();
