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

  // Gooten (recipe + billing are still envs)
  GOOTEN_RECIPE_ID,
  GOOTEN_PARTNER_BILLING_KEY,
  GOOTEN_TEST_MODE,

  // Optional override: if set, we use this SKU directly (must be US-enabled)
  GOOTEN_STICKER_SKU,
} = process.env;

const stripe = new Stripe(STRIPE_SECRET_KEY);

// ---------- Static sticker config (no envs needed) ----------
/**
 * You MUST set the correct Die-Cut Stickers product id from Gooten here.
 * Grab it from their "productvariants" call in your browser Network tab.
 * Example placeholder shown; replace with the real one from your account/catalog.
 */
const GOOTEN_PRODUCT_ID = "PUT_PRODUCT_ID_HERE"; // e.g. "1089" (string or number works)
const DESIRED_SIZE = "525x725"; // e.g. "4x4", "5x5", "525x725"
const DESIRED_PACK = "1Pack";   // e.g. "1Pack", "10Pack"
const DESIRED_VARIANT = "Single"; // e.g. "Single", "Gloss", etc. (depends on catalog naming)

// ---------- Helpers ----------
const MAX_SOURCEID_LEN = 50;
const safeSourceId = (id) => (id ? String(id).slice(0, MAX_SOURCEID_LEN) : undefined);

async function getUsEnabledStickerSku() {
  if (!GOOTEN_PRODUCT_ID) {
    throw new Error("GOOTEN_PRODUCT_ID is missing. Set the product id for Die-Cut Stickers at the top of server.js.");
  }

  const url = `https://api.print.io/api/v/5/source/api/productvariants/?productid=${encodeURIComponent(
    GOOTEN_PRODUCT_ID
  )}&countrycode=US`;

  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Gooten productvariants failed: ${resp.status} ${await resp.text()}`);
  }

  const data = await resp.json();

  // Try to normalize possible response shapes:
  const list =
    data?.ProductVariants ||
    data?.Variants ||
    data?.Data ||
    data?.Items ||
    (Array.isArray(data) ? data : []) ||
    [];

  // Filter for variants that are enabled/available in US
  const variants = list.filter((v) => {
    const enabledCountries = v?.IsEnabledIn || v?.EnabledIn || v?.AvailableIn || [];
    const isEnabledFlag = v?.IsEnabled === true || v?.IsEnabledInUS === true;
    return isEnabledFlag || (Array.isArray(enabledCountries) && enabledCountries.includes("US"));
  });

  if (!variants.length) {
    throw new Error("No US-enabled variants returned by Gooten for this product.");
  }

  // Prefer a SKU that matches our desired size/pack/variant tokens in its name/SKU
  const pick = variants.find((v) => {
    const sku = v?.Sku || v?.SKU || "";
    const name = v?.Name || v?.VariantName || "";
    const hay = `${sku} ${name}`;
    return (
      hay.includes(DESIRED_SIZE) &&
      hay.includes(DESIRED_PACK) &&
      hay.includes(DESIRED_VARIANT)
    );
  });

  const chosen = pick || variants[0];
  const sku = chosen?.Sku || chosen?.SKU;
  if (!sku) throw new Error("Could not determine a SKU from variants.");
  return sku;
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
          output_format: "png", // PNG = best for stickers
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

  const safeId = safeSourceId(sourceId);

  // If GOOTEN_STICKER_SKU is provided, use it; else auto-pick a valid US SKU
  const sku =
    (GOOTEN_STICKER_SKU && GOOTEN_STICKER_SKU.trim()) || (await getUsEnabledStickerSku());

  const body = {
    ShipToAddress: shipTo,
    BillingAddress: shipTo,
    Items: [
      {
        Quantity: 1,
        SKU: sku,                   // US-enabled catalog SKU
        ShipType: "standard",
        Images: [{ Url: imageUrl }], // per-order unique art
        SourceId: safeId,            // <= 50 chars
      },
    ],
    Payment: { PartnerBillingKey: GOOTEN_PARTNER_BILLING_KEY },
    IsInTestMode: String(GOOTEN_TEST_MODE).toLowerCase() === "true",
    SourceId: safeId,                 // <= 50 chars
    IsPartnerSourceIdUnique: true,    // prevent dupes if Stripe retries
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

  return resp.json(); // returns order object with Id, etc.
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

      // Submit to Gooten
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
          // Stripe session IDs can exceed 50 chars; trimmed inside submitGootenOrder.
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
