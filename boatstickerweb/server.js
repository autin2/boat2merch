import express from "express";
import multer from "multer";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const upload = multer({ dest: "uploads/" });

// Use environment variables for secrets
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
const MODEL_VERSION_ID = process.env.MODEL_VERSION_ID;

app.use(express.static("public"));

app.post("/generate-image", upload.single("boatImage"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  try {
    // You can upload the file to a temporary hosting service here or serve locally if accessible publicly
    // For example, using your own server URL (adjust as necessary)
    const imageUrl = `http://your-public-domain-or-ngrok-url/uploads/${req.file.filename}`;

    console.log("Tmpfiles URL:", imageUrl);

    const response = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: {
        Authorization: `Token ${REPLICATE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version: MODEL_VERSION_ID,
        input: {
          image: imageUrl,
          text: "technical line drawing, sketch style of a fishing boat"
        },
      }),
    });

    const data = await response.json();
    console.log("Replicate API response:", data);

    if (!data.id) {
      return res.status(500).json({ error: "No prediction ID returned from Replicate", details: data });
    }

    res.json({ prediction: { id: data.id } });
  } catch (error) {
    console.error("Image generation error:", error);
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
    console.error("Prediction status error:", error);
    res.status(500).json({ error: "Failed to get prediction status" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
