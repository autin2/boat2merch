// server.js
import express from "express";
import multer from "multer";
import fetch from "node-fetch";
import FormData from "form-data";
import Stripe from "stripe";
import nodemailer from "nodemailer";
import sharp from "sharp"; // JPEG/WEBP -> PNG, resize, auto-orient
import path from "path";
import fs from "fs/promises";

const app = express();

// Memory storage + strict file size (keeps RAM controlled)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 }, // 12MB
});

const {
  // Image gen
  REPLICATE_API_TOKEN,
  OPENAI_API_KEY,

  // Stripe
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,

  // Email
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,

  // Gooten (recipe + billing are envs)
  GOOTEN_RECIPE_ID,
  GOOTEN_PARTNER_BILLING_KEY,
  GOOTEN_TEST_MODE,

  // Optional override (validated against country; ignored if unavailable)
  GOOTEN_STICKER_SKU,
} = process.env;

const stripe = new Stripe(STRIPE_SECRET_KEY);

// ---------- Static sticker config ----------
const GOOTEN_PRODUCT_ID = "PUT_PRODUCT_ID_HERE"; // e.g. "1089"
const DESIRED_SIZE = "525x725";
const DESIRED_PACK = "1Pack";
const DESIRED_VARIANT = "Single";

// ---------- Replicate (gpt-image-1) ----------
/** Use a known-good gpt-image-1 version hash from Replicate. */
const GPT_IMAGE_VERSION =
  "bf62744a8f9b8c5775d510ebfa7aaf11866d35afd31952f3f053218df8470e1e"; // openai/gpt-image-1 version

// ---------- Helpers ----------
const MAX_SOURCEID_LEN = 50;
const safeSourceId = (id) => (id ? String(id).slice(0, MAX_SOURCEID_LEN) : undefined);

function normalizeCountryCode(input, fallback = "US") {
  if (!input) return fallback;
  const raw = String(input).trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(raw)) return raw;
  const MAP = {
    "UNITED STATES": "US",
    "UNITED STATES OF AMERICA": "US",
    "USA": "US",
    "U.S.": "US",
    "U.S.A.": "US",
    "AMERICA": "US",
    "CANADA": "CA",
  };
  return MAP[raw] || fallback;
}

function getShipCountryCode(addr) {
  const c =
    addr?.country ||
    addr?.CountryCode ||
    (typeof addr?.Country === "string" ? addr.Country : null);
  return normalizeCountryCode(c, "US");
}

// --- small in-memory cache to avoid repeated huge parses ---
const variantsCache = new Map(); // key: countryCode -> [{sku,name}]
const MAX_VARIANTS_BODY_BYTES = 5 * 1024 * 1024; // 5 MB safety cap
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
    data?.ProductVariants ||
    data?.Variants ||
    data?.Data ||
    data?.Items ||
    (Array.isArray(data) ? data : []) ||
    [];

  const enabled = list.filter((v) => {
    const enabledCountries = v?.IsEnabledIn || v?.EnabledIn || v?.AvailableIn || [];
    const flag =
      v?.IsEnabled === true ||
      v?.IsEnabledInUS === true ||
      v?.IsEnabledInCA === true;
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

  const chosen = pickPreferredVariant(enabled, {
    size: DESIRED_SIZE,
    pack: DESIRED_PACK,
    variant: DESIRED_VARIANT,
  });

  if (!chosen) throw new Error(`Could not pick a SKU for ${countryCode}.`);
  console.log(`[Gooten] Selected SKU for ${countryCode}: ${chosen}`);
  return chosen;
}

// ---------- Nodemailer ----------
const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: parseInt(SMTP_PORT, 10),
  secure: SMTP_PORT === "465",
  auth: { user: SMTP_USER, pass: SMTP_PASS },
});


app.use("/images", express.static(path.join(process.cwd(), "src/public/images"), {
  maxAge: "7d",
}));



// ---------- Static + JSON parsing ----------
app.use(express.static("public"));
app.use((req, res, next) => {
  if (req.originalUrl === "/webhook") {
    next(); // Stripe webhook uses raw body parsing below
  } else {
    express.json({ limit: "2mb" })(req, res, next); // keep JSON body small
  }
});

// ---------- Image generation (Replicate -> OpenAI gpt-image-1, with fallback) ----------
app.post("/generate-image", upload.single("boatImage"), async (req, res) => {
  const t0 = Date.now();
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded (field name must be 'boatImage')." });
    if (!REPLICATE_API_TOKEN || !OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing API credentials (REPLICATE_API_TOKEN and/or OPENAI_API_KEY)." });
    }

    const mode = (req.body?.mode || "sticker").toLowerCase();
    const isSticker = mode === "sticker";

    // Prompts per mode (explicitly avoid cropping; include margin)
    const prompt = isSticker
      ? "Create a clean, high-contrast black and white line drawing of the boat shown in the input image, with a thick white contour outline around the entire boat so it looks like a die-cut sticker. Transparent background. Include the entire boat with a small margin; do not crop or cut off any part. No extra elements, no shadows."
      : "Create a clean, high-contrast black and white line drawing of the boat shown in the input image. The background must be fully solid white. Include the entire boat with a small margin around it; do not crop or cut off any part. No extra elements, no shadows, no artistic effects — just a clear outline and main details of the boat.";

    // Background control per mode (this enforces white vs transparent)
    const backgroundSetting = isSticker ? "transparent" : "opaque";

    // ---------- Input preprocessing: pad canvas to avoid tight crops ----------
    // Resize inside a reasonable max, then extend canvas ~12% on all sides.
    // Sticker gets transparent pad; Image gets white pad.
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
    req.file.buffer = null; // free memory

    const kb = Math.round(pngBuffer.byteLength / 1024);
    console.log(`[generate-image] mode=${mode} input ~${kb}KB`);

    // First try: data URL (simplest)
    const dataUrl = `data:image/png;base64,${pngBuffer.toString("base64")}`;

    const makePrediction = async (imageRef) => {
      const createResp = await fetch("https://api.replicate.com/v1/predictions", {
        method: "POST",
        headers: {
          Authorization: `Token ${REPLICATE_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          // IMPORTANT: Replicate's OpenAI wrapper needs "version", not "model"
          version: GPT_IMAGE_VERSION,
          input: {
            input_images: [imageRef],
            image: imageRef, // compatibility
            prompt,
            background: backgroundSetting, // enforce white vs transparent per mode
            openai_api_key: OPENAI_API_KEY,
            quality: "auto",
            // aspect_ratio: (removed to avoid forced square cropping)
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
        const code = createResp.status;
        return { ok: false, code, payload: msg };
      }
      if (!payload?.id) {
        return { ok: false, code: 500, payload: payload || "No prediction id" };
      }
      return { ok: true, id: payload.id };
    };

    // Try data URL
    let pred = await makePrediction(dataUrl);

    // If data URL fails (size/content), fall back to tmpfiles URL
    if (!pred.ok) {
      const errText = String(pred.payload || "");
      const shouldFallback =
        pred.code >= 400 &&
        (
          errText.includes("data URL") ||
          errText.includes("base64") ||
          errText.includes("Too Large") ||
          errText.includes("payload") ||
          errText.includes("unsupported") ||
          errText.includes("input_images")
        );

      if (shouldFallback) {
        console.warn("[generate-image] data URL rejected, falling back to tmpfiles…");

        // Upload to tmpfiles
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

    console.log(`[generate-image] created prediction ${pred.id} in ${Date.now()-t0}ms`);
    res.json({ prediction: { id: pred.id } });
  } catch (error) {
    console.error("❌ Image generation error:", error);
    res.status(500).json({ error: error?.message || "Failed to generate image" });
  }
});

// 2) List images for the examples page
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



// ---------- Poll prediction ----------
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

    res.json(statusData);
  } catch (error) {
    console.error("❌ Prediction status error:", error);
    res.status(500).json({ error: error?.message || "Failed to get prediction status" });
  }
});

// ---------- Debug: see what SKUs are enabled ----------
app.get("/debug/gooten-variants", async (req, res) => {
  try {
    const country = normalizeCountryCode(req.query.country || "US");
    const enabled = await fetchVariantsForCountry(country);
    res.json({ country, enabledCount: enabled.length, enabled });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---------- Gooten order helper ----------
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
        SKU: sku,                    // validated country-enabled catalog SKU
        ShipType: "standard",
        Images: [{ Url: imageUrl }], // dynamic art
        SourceId: safeId,
      },
    ],
    Payment: { PartnerBillingKey: GOOTEN_PARTNER_BILLING_KEY },
    IsInTestMode: String(GOOTEN_TEST_MODE).toLowerCase() === "true",
    SourceId: safeId,
    IsPartnerSourceIdUnique: true,
  };

  const url = `https://api.print.io/api/v/5/source/api/orders/?recipeid=${encodeURIComponent(
    GOOTEN_RECIPE_ID
  )}`;
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

// ---------- Stripe: Checkout Session ----------
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
            unit_amount: 700, // $7.00
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      customer_email: email,
      shipping_address_collection: { allowed_countries: ["US", "CA"] },
      metadata: {
        imageUrl,
        buyerName: name,
        buyerAddress: JSON.stringify(address),
      },
      success_url: "https://boat2merch.onrender.com/thank-you.html",
      cancel_url: "https://boat2merch.com",
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("❌ /create-checkout-session error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Stripe webhook -> Gooten order + email ----------
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error("⚠️ Webhook signature verification failed.", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      const buyerEmail =
        session.customer_details?.email || session.customer_email || "unknown";
      const imageUrl = session.metadata?.imageUrl || "";
      const buyerName =
        session.metadata?.buyerName || session.customer_details?.name || "Customer";

      const shipping =
        session.shipping_details?.address ||
        (() => {
          try {
            return JSON.parse(session.metadata?.buyerAddress || "{}");
          } catch {
            return {};
          }
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
          from: `"boat2merch" <${SMTP_USER}>`,
          to: "charliebrayton8@gmail.com",
          subject: `New Sticker Order from ${buyerName}`,
          html: emailHtml,
        });
        console.log("✅ Order email sent");
      } catch (mailErr) {
        console.error("❌ Error sending order email:", mailErr);
      }
    }

    res.json({ received: true });
  }
);

// ---------- Start server ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));



