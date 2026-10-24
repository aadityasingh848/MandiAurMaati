import { GoogleGenAI } from "@google/genai";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
const gemini = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  : null;

const GEMINI_MODEL =
  process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
const PORT = Number(process.env.PORT) || 3000;

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_PUBLISHABLE_KEY) {
  console.error("Missing Supabase settings. Check backend/.env");
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_PUBLISHABLE_KEY
);

app.use(helmet());
app.use(cors({
  origin: process.env.CLIENT_ORIGIN || "http://127.0.0.1:5500"
}));
app.use(express.json({ limit: "1mb" }));

app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 200,
  standardHeaders: "draft-8",
  legacyHeaders: false
}));

app.get("/", (req, res) => {
  res.json({
    name: "MandiAurMaati API",
    status: "running"
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "MandiAurMaati API"
  });
});

app.get("/api/crops", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("crop_listings")
      .select("id, crop_name, category, quantity, unit, price_per_unit, quality, village, district, state, status, created_at")
      .eq("status", "available")
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Supabase query failed:", error.message);
      return res.status(500).json({
        error: "Could not load crop listings"
      });
    }

    res.json({ crops: data });
  } catch (error) {
    console.error("Unexpected error:", error.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/api/crops", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : "";

    if (!token) {
      return res.status(401).json({
        error: "Please sign in before adding a crop listing."
      });
    }

    // Verify the seller's access token with Supabase Auth.
    const { data: userData, error: authError } =
      await supabase.auth.getUser(token);

    if (authError || !userData.user) {
      return res.status(401).json({
        error: "Your sign-in session is invalid or expired. Please sign in again."
      });
    }

    const user = userData.user;
    const {
      crop_name,
      category,
      quantity,
      unit,
      price_per_unit,
      quality,
      description,
      village,
      district,
      state,
      latitude,
      longitude
    } = req.body || {};

    if (
      typeof crop_name !== "string" ||
      !crop_name.trim() ||
      !Number.isFinite(quantity) ||
      quantity <= 0 ||
      !Number.isFinite(price_per_unit) ||
      price_per_unit < 0 ||
      typeof unit !== "string" ||
      !unit.trim()
    ) {
      return res.status(400).json({
        error: "Enter a crop name, valid quantity, unit, and asking price."
      });
    }

    // Use the verified seller ID, never an ID supplied by the browser.
    const sellerSupabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_PUBLISHABLE_KEY,
      {
        global: {
          headers: {
            Authorization: `Bearer ${token}`
          }
        },
        auth: {
          persistSession: false,
          autoRefreshToken: false
        }
      }
    );

    const { data, error } = await sellerSupabase
      .from("crop_listings")
      .insert({
        seller_id: user.id,
        crop_name: crop_name.trim().slice(0, 80),
        category: typeof category === "string"
          ? category.trim().slice(0, 100) || "Other"
          : "Other",
        quantity,
        unit: unit.trim().slice(0, 30),
        price_per_unit,
        quality: typeof quality === "string"
          ? quality.trim().slice(0, 100) || null
          : null,
        description: typeof description === "string"
          ? description.trim().slice(0, 500) || null
          : null,
        village: typeof village === "string"
          ? village.trim().slice(0, 100) || null
          : null,
        district: typeof district === "string"
          ? district.trim().slice(0, 100) || null
          : null,
        state: typeof state === "string"
          ? state.trim().slice(0, 100) || null
          : null,
        latitude: Number.isFinite(latitude) ? latitude : null,
        longitude: Number.isFinite(longitude) ? longitude : null,
        status: "available"
      })
      .select("id, crop_name, category, quantity, unit, price_per_unit, quality, village, district, state, status, created_at")
      .single();

    if (error) {
      console.error("Supabase insert failed:", error.message);
      return res.status(500).json({
        error: "Could not save the crop listing. Please check the listing details and try again."
      });
    }

    return res.status(201).json({ crop: data });
  } catch (error) {
    console.error("Unexpected crop-saving error:", error.message);
    return res.status(500).json({
      error: "Internal server error"
    });
  }
});


app.post("/api/assistant", async (req, res) => {
  const message = req.body?.message;

  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({
      error: "Please enter a question."
    });
  }

  if (message.length > 2000) {
    return res.status(400).json({
      error: "Please keep your question under 2,000 characters."
    });
  }

  if (!gemini) {
    return res.status(503).json({
      error: "The farming assistant is not configured yet."
    });
  }

  const prompt = message.trim();
  const systemInstruction = `
You are Kisan Sakha, the farming assistant for MandiAurMaati,
an Indian agricultural marketplace.

Help farmers with crop growing, post-harvest handling,
marketplace usage, and general agricultural questions.
Be friendly, concise, and easy to understand.
Reply in the language used by the farmer when possible.
Do not invent live mandi prices, weather forecasts, or
government scheme eligibility. Clearly say when information
needs verification. For pesticide or serious crop-disease
questions, recommend confirmation with a local KVK or
agriculture officer before treatment.
`;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await gemini.models.generateContent({
        model: GEMINI_MODEL,
        contents: prompt,
        config: {
          systemInstruction,
          maxOutputTokens: 500
        }
      });

      const answer = result.text;

      if (!answer || !answer.trim()) {
        return res.status(502).json({
          error: "The assistant returned an empty reply. Please try again."
        });
      }

      return res.json({ answer: answer.trim() });
    } catch (error) {
      const status = Number(error?.status || error?.code || 0);
      const retryable =
        status === 429 ||
        status === 503 ||
        status >= 500;

      // Retry only temporary errors, at most twice.
      if (retryable && attempt < 2) {
        const delay = 1000 * (2 ** attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      // Log only status information, never the key or full request.
      console.error("Gemini assistant failed:", {
        status: status || "unknown",
        attempts: attempt + 1
      });

      if (status === 429 || status === 503 || status >= 500) {
        return res.status(503).json({
          error: "The farming assistant is busy right now. Please try again in a moment."
        });
      }

      if (status === 400 || status === 404) {
        return res.status(502).json({
          error: "The configured Gemini model or request was rejected. Check the model setting and try again."
        });
      }

      if (status === 401 || status === 403) {
        return res.status(502).json({
          error: "The assistant could not authenticate with Gemini. Check the backend API key and project access."
        });
      }

      return res.status(502).json({
        error: "The assistant could not respond right now. Please try again later."
      });
    }
  }
});


app.listen(PORT, () => {
  console.log(`MandiAurMaati API running at http://localhost:${PORT}`);
});
