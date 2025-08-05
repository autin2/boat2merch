import express from "express";
import multer from "multer";
import fetch from "node-fetch";
import FormData from "form-data";
import fs from "fs";

const app = express();
const upload = multer({ dest: "uploads/" });

// Env vars
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
const MODEL_VERSION_ID = process.env.MODEL_VERSION_ID;

app.use(express.static("public"));

app.post("/generate-image", upload.single("boatImage"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  try {
    // Create FormData and append file stream (use fs.createReadStream for multer saved file)
    const form = new FormData();
    form.append("file", fs.createReadStream(req.file.path), req.file.originalname);

    const uploadResp = await fetch("https://tmpfiles.org/api/v1/upload", {
      method: "POST",
      body: form,
      headers: form.getHeaders(),
    });

    const uploadData = await uploadResp.json();

    if (!uploadResp.ok || !uploadData.url) {
      return res.status(500).json({ error: "Failed to upload image to tmpfiles" });
    }

    console.log("Tmpfiles URL:", uploadData.url);

    // Call Replicate with uploaded image URL and prompt text
    const replicateResp = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: {
        Authorization: `Token ${REPLICATE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version: MODEL_VERSION_ID,
        input: {
          image: uploadData.url,
          text: "technical line drawing, sketch style of a fishing boat"
        },
      }),
    });

    const replicateData = await replicateResp.json();
    console.log("Replicate API response:", replicateData);

    if (!replicateData.id) {
      return res.status(500).json({ error: "No prediction ID returned from Replicate", details: replicateData });
    }

    res.json({ prediction: { id: replicateData.id } });
  } catch (error) {
    console.error("Image generation error:", error);
    res.status(500).json({ error: "Failed to generate image", details: error.message || error.toString() });
  }
});

app.get("/prediction-status/:id", async (req, res) => {
  try {
    const predictionId = req.params.id;
    const statusResp = await fetch(`https://api.replicate.com/v1/predictions/${predictionId}`, {
      headers: { Authorization: `Token ${REPLICATE_API_TOKEN}` },
    });
    const statusData = await statusResp.json();
    res.json(statusData);
  } catch (error) {
    console.error("Prediction status error:", error);
    res.status(500).json({ error: "Failed to get prediction status" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

