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
  if (!req.file) {
    console.error("No file uploaded");
    return res.status(400).json({ error: "No file uploaded" });
  }

  try {
    console.log("Received file:", req.file);

    const form = new FormData();
    form.append("file", req.file.buffer || fs.createReadStream(req.file.path), req.file.originalname);

    console.log("Uploading file to tmpfiles.org...");
    const uploadResp = await fetch("https://tmpfiles.org/api/v1/upload", {
      method: "POST",
      body: form,
      headers: form.getHeaders(),
    });

    if (!uploadResp.ok) {
      const text = await uploadResp.text();
      console.error("Upload to tmpfiles failed:", uploadResp.status, text);
      return res.status(500).json({ error: "Failed to upload image to tmpfiles", details: text });
    }

    const uploadData = await uploadResp.json();
    console.log("Tmpfiles URL:", uploadData.url);

    if (!uploadData.url) {
      console.error("No URL returned from tmpfiles upload", uploadData);
      return res.status(500).json({ error: "No URL returned from tmpfiles" });
    }

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

    if (!replicateResp.ok) {
      const text = await replicateResp.text();
      console.error("Replicate API call failed:", replicateResp.status, text);
      return res.status(500).json({ error: "Replicate API call failed", details: text });
    }

    const replicateData = await replicateResp.json();
    console.log("Replicate API response:", replicateData);

    if (!replicateData.id) {
      console.error("No prediction ID from Replicate", replicateData);
      return res.status(500).json({ error: "No prediction ID returned from Replicate", details: replicateData });
    }

    res.json({ prediction: { id: replicateData.id } });
  } catch (error) {
    console.error("Image generation error:", error);
    res.status(500).json({ error: "Failed to generate image", details: error.message });
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

