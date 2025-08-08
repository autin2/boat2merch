import express from "express";
import multer from "multer";
import fetch from "node-fetch";
import FormData from "form-data";
import fs from "fs";
import Stripe from "stripe";

const app = express();
const upload = multer({ dest: "uploads/" });

// Environment variables (set in your hosting environment or locally)
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const PRINTFUL_API_KEY = process.env.PRINTFUL_API_KEY;

const stripe = new Stripe(STRIPE_SECRET_KEY);

app.use(express.static("public"));
app.use(express.json()); // to parse JSON bodies for /create-order

// Upload & generate image endpoint
app.post("/generate-image", upload.single("boatImage"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  try {
    console.log("📂 Received file:", req.file);

    // Upload the file to tmpfiles.org
    const form = new FormData();
    form.append("file", fs.createReadStream(req.file.path), req.file.originalname);

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

    // Convert URL to direct download link if needed
    let imageUrl = uploadData.data.url;
    if (!imageUrl.includes("/dl/")) {
      imageUrl = imageUrl.replace("tmpfiles.org/", "tmpfiles.org/dl/");
    }
    console.log("🔗 Direct image URL for AI:", imageUrl);

    // Call Replicate API to generate the image with updated prompt
    console.log(`🚀 Calling Replicate model: openai/gpt-image-1`);
    const replicateResp = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: {
        Authorization: `Token ${REPLICATE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version: "openai/gpt-image-1",
        input: {
          prompt:
            "Create a clean black and white line drawing of the boat shown in the input image only, with a thick white contour outline around the entire boat so it looks like a die-cut sticker. Transparent background, no extra elements or shadows.",
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

// Helper to create Printful order
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

// Create order + process payment endpoint
app.post("/create-order", async (req, res) => {
  try {
    const { email, name, address, imageUrl, paymentMethodId } = req.body;
    if (!email || !name || !address || !imageUrl || !paymentMethodId) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // 1. Create PaymentIntent with Stripe
    const paymentIntent = await stripe.paymentIntents.create({
      amount: 1500, // $15.00 in cents — adjust as needed
      currency: "usd",
      payment_method: paymentMethodId,
      confirmation_method: "manual",
      confirm: true,
      receipt_email: email,
    });

    if (paymentIntent.status === "requires_action") {
      // Card requires authentication (3D Secure)
      return res.json({
        requiresAction: true,
        paymentIntentClientSecret: paymentIntent.client_secret,
      });
    } else if (paymentIntent.status === "succeeded") {
      // Payment successful, create Printful order

      const printfulOrder = {
        recipient: {
          name,
          address1: address.line1,
          city: address.city,
          state_code: address.state,
          country_code: address.country,
          zip: address.zip,
          email,
        },
        items: [
          {
            variant_id: 4011, // example Printful sticker variant - verify on your Printful dashboard
            quantity: 1,
            files: [{ url: imageUrl }],
          },
        ],
      };

      const printfulResp = await createPrintfulOrder(printfulOrder);

      return res.json({ success: true, printfulOrder: printfulResp });
    } else {
      return res.status(400).json({ error: "Payment failed" });
    }
  } catch (err) {
    console.error("❌ /create-order error:", err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
