import express from "express";
import multer from "multer";
import fetch from "node-fetch";
import FormData from "form-data";
import fs from "fs";

const app = express();
const upload = multer({ dest: "uploads/" });

// Env vars (set in Render)
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
const MODEL_VERSION_ID =
  process.env.MODEL_VERSION_ID ||
  "3cfd38225f82f47062567c783c555c97ac2669868b0c9a5002e14fe88cdde319"; // cuupid 

app.use(express.static("public"));

// Upload & generate image
app.post("/generate-image", upload.single("boatImage"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  try {
    console.log("📂 Received file:", req.file);

    // Upload to tmpfiles.org
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

    // Ensure correct /dl/ direct link
    let imageUrl = uploadData.data.url;
    if (!imageUrl.includes("/dl/")) {
      imageUrl = imageUrl.replace("tmpfiles.org/", "tmpfiles.org/dl/");
    }
    console.log("🔗 Direct image URL for AI:", imageUrl);

    // Call Replicate
    console.log(`🚀 Calling Replicate model version: ${MODEL_VERSION_ID}`);
    const replicateResp = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: {
        Authorization: `Token ${REPLICATE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version: MODEL_VERSION_ID,
        input: {
          prompt: "a picture in black and white lineart of the boat provided in the image",
          image: imageUrl,
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

// Poll prediction status
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));




