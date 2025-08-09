import express from "express";
import multer from "multer";
import fetch from "node-fetch";
import FormData from "form-data";
import fs from "fs";
import Stripe from "stripe";
import nodemailer from "nodemailer";

const app = express();
const upload = multer({ dest: "uploads/" });

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
/**
 * REQUIRED: Set to Die-Cut Stickers product id from Gooten (string/number).
 * Grab it from the "productvariants" call in your browser Network tab.
 */
const GOOTEN_PRODUCT_ID = "PUT_PRODUCT_ID_HERE"; // e.g. "1089"

const DESIRED_SIZE = "525x725";     // e.g. "4x4", "5x5", "525x725"
const DESIRED_PACK = "1Pack";       // e.g. "1Pack", "10Pack"
const DESIRED_VARIANT = "Single";   // depends on catalog naming

// ---------- Helpers ----------
const MAX_SOURCEID_LEN = 50;
const safeSourceId = (id) => (id ? String(id).slice(0, MAX_SOURCEID_LEN) : undefined);

function getShipCountryCode(addr) {
  const c =
    addr?.country ||
    addr?.CountryCode ||
    (typeof addr?.Country === "string" ? addr.Country : null) ||
    "US";
  return String(c).toUpperCase();
}

async function fetchVariantsForCountry(countryCode) {
  if (!GOOTEN_PRODUCT_ID) {
    throw new Error("GOOTEN_PRODUCT_ID missing. Set the Die-Cut Stickers product id at the top of server.js.");
  }
  if (!GOOTEN_RECIPE_ID) {
    throw new Error("GOOTEN_RECIPE_ID missing. Set it in your Render env vars.");
  }

  const url =
    `https://api.print.io/api/v/5/source/api/productvariants/` +
    `?recipeid=${encodeURIComponent(GOOTEN_RECIPE_ID)}` +
    `&productid=${encodeURIComponent(GOOTEN_PRODUCT_ID)}` +
    `&countrycode=${encodeURIComponent(countryCode)}`;

  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Gooten productvariants failed: ${resp.status} ${await resp.text()}`);
  }
  const data = await resp.json();

  const list =
    data?.ProductVariants ||
    data?.Variants ||
    data?.Data ||
    data?.Items ||
    (Array.isArray(data) ? data : []) ||
    [];

  // Enabled for the given country
  const enabled = list.filter((v) => {
    const enabledCountries = v?.IsEnabledIn || v?.EnabledIn || v?.AvailableIn || [];
    const flag =
      v?.IsEnabled === true ||
      v?.IsEnabledInUS === true ||
      v?.IsEnabledInCA === true;
    return flag || (Array.isArray(enabledCountries) && enabledCountries.includes(countryCode));
  });

  return enabled
    .map((v) => ({
      sku: v?.Sku || v?.SKU || "",
      name: v?.Name || v?.VariantName || "",
    }))
    .filter((v) => v.sku);
}

function pickPreferredVariant(enabled, { size, pack, variant }) {
  // Strict match
  const strict = enabled.find((v) => {
    const hay = `${v.sku} ${v.name}`;
    return hay.includes(size) && hay.includes(pack) && hay.includes(variant);
  });
  if (strict) return strict.sku;

  // Partial by size+pack
  const bySizePack = enabled.find((v) => {
    const hay = `${v.sku} ${v.name}`;
    return hay.includes(size) && hay.includes(pack);
  });
  if (bySizePack) return bySizePack.sku;

  // Fallback
  return enabled[0]?.sku;
}

async function pickSkuForCountry({ preferredSku, countryCode }) {
  const enabled = await fetchVariantsForCountry(countryCode);
  if (!enabled.length) {
    throw new Error(`No enabled variants for ${countryCode}.`);
  }

  // If env override present, validate it's enabled for this country
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
  return chosen;
}

// ---------- Nodemailer ----------
const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: parseInt(SMTP_PORT, 10),
  secure: SMTP_PORT === "465",
  auth: { user: SMTP_USER, pass: SMTP_PASS },
});

// ---------- Static + JSON parsing ----------
app.use(express.static("public"));
app.use((req, res, next) => {
  if (req.originalUrl === "/webhook") {
    next(); // Stripe webhook uses raw body parsing below
  } else {
    express.json()(req, res, next);
  }
});

// ---------- Image generation ----------
app.post("/generate-image", upload.single("boatImage"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const uploadedPath = req.file.path;

  try {
    // mode: "image" (line art only) | "sticker" (line art + white contour)
    const mode = (req.body?.mode || "sticker").toLowerCase();
    const isImageOnly = mode === "image";

    const prompt = isImageOnly
      ? "Create a clean black and white line drawing of the boat shown in the input image only. Transparent background, no extra elements or shadows."
      : "Create a clean black and white line drawing of the boat shown in the input image only, with a thick white contour outline around the entire boat so it looks like a die-cut sticker. Transparent background, no extra elements or shadows.";

    // 1) upload to tmpfiles.org to get public URL
    const form = new FormData();
    form.append("file", fs.createReadStream(uploadedPath), req.file.originalname);

    const uploadResp = await fetch("https://tmpfiles.org/api/v1/upload", {
      method: "POST",
      body: form,
      headers: form.getHeaders(),
    });
    const uploadData = await uploadResp.json();

    if (!uploadData?.data?.url) {
      return res.status(500).json({ error: "No URL returned from tmpfiles" });
    }

    let imageUrl = uploadData.data.url;
    if (!imageUrl.includes("/dl/")) {
      imageUrl = imageUrl.replace("tmpfiles.org/", "tmpfiles.org/dl/");
    }

    // 2) call Replicate (OpenAI gpt-image-1 via Replicate)
    const replicateResp = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: {
        Authorization: `Token ${REPLICATE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version: "openai/gpt-image-1",
        input: {
          prompt,
          input_images: [imageUrl],
          openai_api_key: OPENAI_API_KEY,
          quality: "auto",
          background: "transparent",
          moderation: "auto",
          aspect_ratio: "1:1",
          number_of_images: 1,
          output_format: "png", // PNG best for stickers
          output_compression: 90,
        },
      }),
    });

    const replicateData = await replicateResp.json();
    if (!replicateData.id) {
      return res.status(500).json({
        error: "No prediction ID returned from Replicate",
        details: replicateData,
      });
    }

    res.json({ prediction: { id: replicateData.id } });
  } catch (error) {
    console.error("❌ Image generation error:", error);
    res.status(500).json({ error: "Failed to generate image" });
  } finally {
    if (uploadedPath) fs.promises.unlink(uploadedPath).catch(() => {});
  }
});

// ---------- Poll prediction ----------
app.get("/prediction-status/:id", async (req, res) => {
  try {
    const predictionId = req.params.id;
    const statusResp = await fetch(`https://api.replicate.com/v1/predictions/${predictionId}`, {
      headers: { Authorization: `Token ${REPLICATE_API_TOKEN}` },
    });
    const statusData = await statusResp.json();
    res.json(statusData);
  } catch (error) {
    console.error("❌ Prediction status error:", error);
    res.status(500).json({ error: "Failed to get prediction status" });
  }
});

// ---------- Debug: see what SKUs are enabled ----------
app.get("/debug/gooten-variants", async (req, res) => {
  try {
    const country = String(req.query.country || "US").toUpperCase();
    const enabled = await fetchVariantsForCountry(country);
    res.json({ country, enabledCount: enabled.length, enabled });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---------- Gooten order helper ----------
async function submitGootenOrder({ imageUrl, email, name, address, sourceId }) {
  if (!GOOTEN_RECIPE_ID || !GOOTEN_PARTNER_BILLING_KEY) {
    throw new Error("Gooten env vars missing (GOOTEN_RECIPE_ID / GOOTEN_PARTNER_BILLING_KEY).");
  }

  const shipTo = {
    FirstName: name?.split(" ")?.[0] || "Customer",
    LastName: name?.split(" ")?.slice(1).join(" ") || " ",
    Line1: address?.line1 || "",
    Line2: address?.line2 || "",
    City: address?.city || "",
    State: address?.state || "",
    CountryCode: (address?.country || "US").toUpperCase(),
    PostalCode: address?.postal_code || address?.zip || "",
    Phone: address?.phone || "0000000000",
    Email: email || "unknown@example.com",
  };

  const countryCode = getShipCountryCode(shipTo);

  // Validate env override for the ship country; else pick automatically.
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
            product_data: {
              name: "Boat Sticker",
              images: [imageUrl],
            },
            unit_amount: 700, // $7.00 (adjust as needed)
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

// ---------- Placeholder (unused) ----------
app.post("/create-order", async (req, res) => {
  try {
    res.json({ message: "Order processing placeholder" });
  } catch (err) {
    console.error("❌ /create-order error:", err);
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

      // Prefer Stripe shipping_details; fallback to your metadata JSON
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
          // Trimmed inside submitGootenOrder.
          sourceId: session.id,
        });
        console.log("✅ Gooten order created:", order);
      } catch (e) {
        console.error("❌ Gooten order error:", e);
      }

      // Notify you via email
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

    // Respond fast so Stripe stops retrying
    res.json({ received: true });
  }
);

// ---------- Start server ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
