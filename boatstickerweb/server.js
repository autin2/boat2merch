import express from "express";
import multer from "multer";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";
import FormData from "form-data"; // install this: npm install form-data

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const upload = multer({ dest: "uploads/" });

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
const MODEL_VERSION_ID = process.env.MODEL_VERSION_ID;

app.use(express.static("public"));

app.post("/generate-image", upload.single("boatImage"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  try {
    // 1. Upload file to tmpfiles.org
    const form = new FormData();
    form.append("file", path.join(__dirname, "uploads", req.file.filename), req.file.originalname);

    const tmpResp = await fetch("https://tmpfiles.org/api/v1/upload", {
      method: "POST",
      body: form,
    });

    const tmpData = await tmpResp.json();
    if (!tmpData || !tmpData.data || !tmpData.data.url) {
      throw new Error("Failed to upload to tmpfiles.org");
    }
    const publicFileUrl = tmpData.data.url;
    console.log("Tmpfiles URL:", publicFileUrl);

    // 2. Send to Replicate API
    const replicateResp = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: {
        Authorization: `Token ${REPLICATE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version: MODEL_VERSION_ID,
        input: {
          image: publicFileUrl,
          // add seed here if you want reproducibility, e.g. seed: 42
        },
      }),
    });

    const replicateData = await replicateResp.json();
    console.log("Replicate API response:", replicateData);

    if (!replicateData.id) {
      return res.status(500).json({ error: "No prediction ID returned from Replicate", details: replicateData });
    }

    // 3. Return prediction ID to frontend
    res.json({ prediction: { id: replicateData.id } });
  } catch (error) {
    console.error("Error during generate-image:", error);
    res.status(500).json({ error: error.message || "Failed to generate image" });
  }
});

// Poll prediction status endpoint remains unchanged, here for completeness:
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
app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
