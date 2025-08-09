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
  REPLICATE_API_TOKEN,
  OPENAI_API_KEY,
  STRIPE_SECRET_KEY,
  PRINTFUL_API_KEY,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  EMAIL_TO,
  STRIPE_WEBHOOK_SECRET,
} = process.env;

const stripe = new Stripe(STRIPE_SECRET_KEY);

// ---------- Nodemailer (order notification) ----------
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
    next(); // webhook uses raw body
  } else {
    express.json()(req, res, next);
  }
});

// ---------- Image generation ----------
app.post("/generate-image", upload.single("boatImage"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const uploadedPath = req.file.path;

  try {
    console.log("📂 Received file:", req.file);

    // "image" | "sticker"
    const mode = (req.body?.mode || "sticker").toLowerCase();
    const isImageOnly = mode === "image";

    const prompt = isImageOnly
      ? "Create a clean black and white line drawing of the boat shown in the input image only. Transparent background, no extra elements or shadows."
      : "Create a clean black and white line drawing of the boat shown in the input image only, with a thick white contour outline around the entire boat so it looks like a die-cut sticker. Transparent background, no extra elements or shadows.";

    // Upload to tmpfiles to get a public URL
    const form = new FormData();
    form.append("file", fs.createReadStream(uploadedPath), req.file.originalname);

    console.log("⬆️ Uploading file to tmpfiles.org...");
    const uploadResp = await fetch("https://tmpfiles.org/api/v1/upload", {
      method: "POST",
      body: form,
      headers: form.getHeaders(),
    });
    const uploadData = await uploadResp.json();
    console.log("📦 Tmpfiles response:", uploadData);

    if (!uploadData?.data?.url) {
      return res.status(500).json({ error: "No URL returned from tmpfiles" });
    }

    let imageUrl = uploadData.data.url;
    if (!imageUrl.includes("/dl/")) {
      imageUrl = imageUrl.replace("tmpfiles.org/", "tmpfiles.org/dl/");
    }
    console.log("🔗 Direct image URL for AI:", imageUrl);

    // Kick off Replicate prediction (OpenAI gpt-image-1 via Replicate)
    console.log(`🚀 Calling Replicate model: openai/gpt-image-1 (mode=${mode})`);
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
          output_format: "png", // PNG for stickers
          output_compression: 90,
        },
      }),
    });

    const replicateData = await replicateResp.json();
    console.log("🖼 Replicate API response:", replicateData);

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

// ---------- Printful helpers ----------
async function createPrintfulOrder(orderData) {
  // Using the classic /orders endpoint which accepts variant_id, sync_variant_id, external_variant_id + files[]
  const response = await fetch("https://api.printful.com/orders", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${PRINTFUL_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(orderData),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error("Printful API error: " + err);
  }
  return response.json();
}

// Use whatever ID the user insists on first; fallback later if needed
function buildStickerItemFromId({ anyId, imageUrl }) {
  const isNumeric = /^\d+$/.test(anyId);
  if (isNumeric) {
    // try as sync variant id first
    return {
      sync_variant_id: Number(anyId),
      quantity: 1,
      files: [{ url: imageUrl }],
    };
  } else {
    // try as external variant id (non-numeric hash) — if Printful rejects, we’ll fallback
    return {
      external_variant_id: String(anyId),
      quantity: 1,
      files: [{ url: imageUrl }],
    };
  }
}

// Catalog v2 lookup for Kiss-Cut 4×4 (fallback)
let CACHED_KISS_CUT_4X4_CATALOG_VARIANT_ID = null;

async function getKissCut4x4CatalogVariantId() {
  if (CACHED_KISS_CUT_4X4_CATALOG_VARIANT_ID) return CACHED_KISS_CUT_4X4_CATALOG_VARIANT_ID;

  // 1) Find the "Kiss-Cut Sticker" product
  const prodResp = await fetch("https://api.printful.com/v2/catalog-products?search=kiss%20cut%20sticker", {
    headers: { Authorization: `Bearer ${PRINTFUL_API_KEY}` },
  });
  if (!prodResp.ok) throw new Error("Printful catalog search failed: " + (await prodResp.text()));
  const prodJson = await prodResp.json();
  const product = (prodJson.data || []).find(p =>
    /kiss/i.test(p.name || "") && /sticker/i.test(p.name || "")
  );
  if (!product) throw new Error("Kiss-Cut Sticker catalog product not found");

  // 2) Get variants for that product & pick 4″ × 4″ (prefer White)
  const varResp = await fetch(`https://api.printful.com/v2/catalog-products/${product.id}/catalog-variants`, {
    headers: { Authorization: `Bearer ${PRINTFUL_API_KEY}` },
  });
  if (!varResp.ok) throw new Error("Printful catalog variants failed: " + (await varResp.text()));
  const varJson = await varResp.json();

  const fourByFour = (varJson.data || []).find(v =>
    (v.size || "").replace(/[″”"]/g, '"').match(/4.*×.*4/i) && (!v.color || /white/i.test(v.color))
  );
  if (!fourByFour?.id) throw new Error("4×4 Kiss-Cut catalog variant not found");

  CACHED_KISS_CUT_4X4_CATALOG_VARIANT_ID = fourByFour.id;
  return CACHED_KISS_CUT_4X4_CATALOG_VARIANT_ID;
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
            unit_amount: 700, // $7.00 in cents
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      customer_email: email,
      shipping_address_collection: {
        allowed_countries: ["US", "CA"],
      },
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

// ---------- Placeholder ----------
app.post("/create-order", async (req, res) => {
  try {
    res.json({ message: "Order processing placeholder" });
  } catch (err) {
    console.error("❌ /create-order error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Stripe webhook: email + auto-Printful (try your ID, then fallback) ----------
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
      let recipient;
      if (session.shipping_details?.address) {
        const ship = session.shipping_details;
        recipient = {
          name: buyerName,
          email: buyerEmail,
          address1: ship.address.line1 || "",
          address2: ship.address.line2 || "",
          city: ship.address.city || "",
          state_code: ship.address.state || "",
          country_code: ship.address.country || "",
          zip: ship.address.postal_code || "",
          phone: session.customer_details?.phone || undefined,
        };
      } else {
        let addr = {};
        try { addr = JSON.parse(session.metadata?.buyerAddress || "{}"); } catch {}
        recipient = {
          name: buyerName,
          email: buyerEmail,
          address1: addr.line1 || "",
          address2: addr.line2 || "",
          city: addr.city || "",
          state_code: addr.state || "",
          country_code: addr.country || "",
          zip: addr.postal_code || addr.zip || "",
          phone: addr.phone || undefined,
        };
      }

      // ---- Try order with user-provided ID first; if it fails, fallback to catalog variant id ----
      const USER_PROVIDED_STICKER_ID = "68969a7ad6ae19"; // <— using exactly what you gave me

      let orderCreated = false;
      try {
        const firstItem = buildStickerItemFromId({ anyId: USER_PROVIDED_STICKER_ID, imageUrl });
        const firstOrder = await createPrintfulOrder({
          recipient,
          items: [firstItem],
          confirm: true,
        });
        orderCreated = true;
        console.log("✅ Printful order created (first try):", firstOrder.result?.id || firstOrder);
      } catch (firstErr) {
        console.warn("First try failed, attempting catalog fallback…", firstErr?.message || firstErr);
        try {
          const catalogVariantId = await getKissCut4x4CatalogVariantId();
          const secondOrder = await createPrintfulOrder({
            recipient,
            items: [
              {
                variant_id: catalogVariantId, // numeric catalog ID
                quantity: 1,
                files: [{ url: imageUrl }],
              },
            ],
            confirm: true,
          });
          orderCreated = true;
          console.log("✅ Printful order created (fallback):", secondOrder.result?.id || secondOrder);
        } catch (fallbackErr) {
          console.error("❌ Printful order failed after fallback:", fallbackErr?.message || fallbackErr);
        }
      }

      // Send yourself the email either way (so you’re aware)
      try {
        const buyerAddress = recipient;
        const emailHtml = `
          <h2>New Sticker Order</h2>
          <p><strong>Buyer Name:</strong> ${buyerName}</p>
          <p><strong>Buyer Email:</strong> ${buyerEmail}</p>
          <p><strong>Address:</strong><br/>
            ${buyerAddress.address1 || ""}<br/>
            ${buyerAddress.city || ""}, ${buyerAddress.state_code || ""} ${buyerAddress.zip || ""}<br/>
            ${buyerAddress.country_code || ""}
          </p>
          <p><strong>Sticker Image:</strong></p>
          <img src="${imageUrl}" alt="Purchased Sticker" style="max-width:300px; border:1px solid #ccc; border-radius:6px;" />
          <p>${orderCreated ? "✅ Printful order created automatically." : "⚠️ Printful order creation failed — please place manually."}</p>
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

    // Stripe needs a 200 quickly
    res.json({ received: true });
  }
);

// ---------- Start server ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
