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

// Nodemailer transporter for sending order notification emails
const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: parseInt(SMTP_PORT, 10),
  secure: SMTP_PORT === "465",
  auth: {
    user: SMTP_USER,
    pass: SMTP_PASS,
  },
});

// Serve static files from "public"
app.use(express.static("public"));

// Use JSON parser only on non-webhook routes
app.use((req, res, next) => {
  if (req.originalUrl === "/webhook") {
    next(); // skip JSON parsing for webhook (we use express.raw there)
  } else {
    express.json()(req, res, next); // parse JSON for other routes
  }
});

// Upload & generate image endpoint
app.post("/generate-image", upload.single("boatImage"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const uploadedPath = req.file.path;

  try {
    console.log("📂 Received file:", req.file);

    // Read mode from multipart text fields: "image" | "sticker"
    const mode = (req.body?.mode || "sticker").toLowerCase();
    const isImageOnly = mode === "image";

    // Build prompt based on mode
    const prompt = isImageOnly
      ? "Create a clean black and white line drawing of the boat shown in the input image only. Transparent background, no extra elements or shadows."
      : "Create a clean black and white line drawing of the boat shown in the input image only, with a thick white contour outline around the entire boat so it looks like a die-cut sticker. Transparent background, no extra elements or shadows.";

    // 1) Upload to tmpfiles.org to get a public URL
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

    // 2) Kick off Replicate prediction (OpenAI gpt-image-1 via Replicate)
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
          output_format: "webp",
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
    // Clean up local temp file
    if (uploadedPath) {
      fs.promises.unlink(uploadedPath).catch(() => {});
    }
  }
});

// Poll prediction status endpoint
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

// Helper to create Printful order (not currently used)
async function createPrintfulOrder(orderData) {
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

// Create Stripe Checkout Session endpoint with metadata
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
            unit_amount: 700, // $7.00 in cents (update as needed)
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
        imageUrl: imageUrl,
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

// Placeholder /create-order endpoint
app.post("/create-order", async (req, res) => {
  try {
    res.json({ message: "Order processing placeholder" });
  } catch (err) {
    console.error("❌ /create-order error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Stripe webhook endpoint to send order email on purchase
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  (req, res) => {
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

      const buyerEmail = session.customer_email || "unknown";
      const imageUrl = session.metadata?.imageUrl || "";
      const buyerName = session.metadata?.buyerName || "Customer";
      let buyerAddress = {};
      try {
        buyerAddress = JSON.parse(session.metadata?.buyerAddress || "{}");
      } catch {
        buyerAddress = {};
      }

      // Compose email content
      const emailHtml = `
        <h2>New Sticker Order</h2>
        <p><strong>Buyer Name:</strong> ${buyerName}</p>
        <p><strong>Buyer Email:</strong> ${buyerEmail}</p>
        <p><strong>Address:</strong><br/>
          ${buyerAddress.line1 || ""}<br/>
          ${buyerAddress.city || ""}, ${buyerAddress.state || ""} ${buyerAddress.postal_code || buyerAddress.zip || ""}<br/>
          ${buyerAddress.country || ""}
        </p>
        <p><strong>Sticker Image:</strong></p>
        <img src="${imageUrl}" alt="Purchased Sticker" style="max-width:300px; border:1px solid #ccc; border-radius:6px;" />
        <p>View order details in Stripe Dashboard.</p>
      `;

      const mailOptions = {
        from: `"boat2merch" <${SMTP_USER}>`,
        to: "charliebrayton8@gmail.com", // Your email address here
        subject: `New Sticker Order from ${buyerName}`,
        html: emailHtml,
      };

      transporter.sendMail(mailOptions, (error, info) => {
        if (error) {
          console.error("❌ Error sending order email:", error);
        } else {
          console.log("✅ Order email sent:", info.response);
        }
      });
    }

    res.json({ received: true });
  }
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
