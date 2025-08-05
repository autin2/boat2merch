import express from "express";
import multer from "multer";
import fetch from "node-fetch";

const app = express();
const upload = multer({ dest: "uploads/" });

// Env vars on Render:
// REPLICATE_API_TOKEN = your replicate token
// MODEL_VERSION_ID = version ID of openai/gpt-image-1 (get from https://replicate.com/openai/gpt-image-1)

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
const MODEL_VERSION_ID = process.env.MODEL_VERSION_ID;

app.use(express.static("public"));

app.post("/generate-image", upload.none(), async (req, res) => {
  try {
    // Since this model doesn't accept an image input, only prompt:
    const prompt =
      "A precise black and white line drawing of a fishing boat, technical sketch style, no background, clean lines";

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
          prompt,
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
