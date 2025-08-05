import express from "express";
import multer from "multer";
import fetch from "node-fetch";

const app = express();
const upload = multer();

// Environment variables
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
const MODEL_VERSION_ID = process.env.MODEL_VERSION_ID;

if (!REPLICATE_API_TOKEN || !MODEL_VERSION_ID) {
  console.error("❌ Missing environment variables REPLICATE_API_TOKEN or MODEL_VERSION_ID");
  process.exit(1);
}

// Allow frontend files from /public
app.use(express.static("public"));

app.post("/generate-image", upload.single("boatImage"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    // Convert uploaded file to base64
    const base64Image = `data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}`;

    // Step 1: Create prediction
    const createResp = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: {
        Authorization: `Token ${REPLICATE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version: MODEL_VERSION_ID,
        input: {
          image: base64Image
        },
      }),
    });

    const prediction = await createResp.json();
    if (!prediction.id) {
      return res.status(500).json({ error: "Failed to start prediction", details: prediction });
    }

    // Step 2: Poll until complete
    let outputUrl = null;
    let status = prediction.status;
    const predictionId = prediction.id;

    while (status !== "succeeded" && status !== "failed") {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const statusResp = await fetch(`https://api.replicate.com/v1/predictions/${predictionId}`, {
        headers: { Authorization: `Token ${REPLICATE_API_TOKEN}` },
      });
      const statusData = await statusResp.json();
      status = statusData.status;
      if (status === "succeeded") {
        outputUrl = statusData.output?.[0] || null;
      } else if (status === "failed") {
        return res.status(500).json({ error: "Prediction failed" });
      }
    }

    // Step 3: Send output URL back to frontend
    res.json({ imageUrl: outputUrl });

  } catch (error) {
    console.error("Image generation error:", error);
    res.status(500).json({ error: "Failed to generate image" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running at http://localhost:${PORT}`));
