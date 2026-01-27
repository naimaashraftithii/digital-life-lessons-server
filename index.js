require("dotenv").config();

const express = require("express");
const app = express();
const cors = require("cors");
/* -------------------- CORS -------------------- */

const Stripe = require("stripe");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");


app.set("trust proxy", 1);
const port = process.env.PORT || 3000;

/* -------------------- Stripe -------------------- */
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/* -------------------- Mongo Globals -------------------- */
let usersCollection,
  lessonsCollection,
  favoritesCollection,
  lessonReportsCollection,
  paymentsCollection,
  commentsCollection;

let dbReady = false;

/* -------------------- Stripe Webhook (MUST be before express.json) -------------------- */
app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    if (!dbReady) return res.status(503).json({ message: "DB not ready yet" });

    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error("❌ Webhook signature verify failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const uid = session?.metadata?.uid;
      const email = session?.metadata?.email || session.customer_email;

      if (uid) {
        await usersCollection.updateOne(
          { uid },
          { $set: { isPremium: true, updatedAt: new Date() } }
        );

        await paymentsCollection.insertOne({
          uid,
          email,
          stripeSessionId: session.id,
          stripePaymentIntentId: session.payment_intent,
          amount: session.amount_total,
          currency: session.currency,
          status: "paid",
          createdAt: new Date(),
        });

        console.log("✅ Premium activated for uid:", uid);
      }
    }

    return res.json({ received: true });
  } catch (e) {
    console.error("❌ Webhook handler error:", e.message);
    return res.status(500).json({ message: e.message });
  }
});

/* -------------------- CORS -------------------- */
app.use(
  cors({
    origin: (origin, cb) => {
      const allowed = [
        process.env.CLIENT_URL,
        "http://localhost:5173",
        "http://localhost:3000",

        // production netlify (add exact origins)
        "https://digitallife-lessons-client.netlify.app",
        "https://digital-life-lessons-client.netlify.app",
      ]
        .filter(Boolean)
        .map((u) => u.replace(/\/$/, "")); // remove trailing slash

      if (!origin) return cb(null, true);

      const normalizedOrigin = origin.replace(/\/$/, "");
      if (allowed.includes(normalizedOrigin)) return cb(null, true);

      return cb(new Error("Not allowed by CORS: " + origin));
    },
    credentials: true,
  })
);

/* -------------------- JSON (after webhook) -------------------- */
app.use(express.json());

/* -------------------- MongoDB Connect -------------------- */
const pass = encodeURIComponent(process.env.DB_PASSWORD);
const uri = `mongodb+srv://${process.env.DB_USER}:${pass}@cluster0.x6bmi0l.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
});

async function run() {
  await client.connect();
  const db = client.db(process.env.DB_NAME);

  usersCollection = db.collection("users");
  lessonsCollection = db.collection("lessons");
  favoritesCollection = db.collection("favorites");
  lessonReportsCollection = db.collection("lessonReports");
  paymentsCollection = db.collection("payments");
  commentsCollection = db.collection("comments");

  dbReady = true;
  console.log("✅ MongoDB connected");
}

run().catch((err) => {
  dbReady = false;
  console.log("❌ Mongo connect error:", err.message);
});

/* -------------------- Basic Routes -------------------- */
app.get("/", (req, res) => res.send("✅ Digital Life Lessons Server Running"));

app.get("/health", async (req, res) => {
  try {
    const db = client.db(process.env.DB_NAME);
    const ping = await db.command({ ping: 1 });
    res.json({ ok: true, ping });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

/* =========================
   ✅ HOME
   ========================= */
// GET /home/featured
app.get("/home/featured", async (req, res) => {
  try {
    if (!dbReady) return res.status(503).json({ message: "DB not ready" });

    const lessons = await lessonsCollection
      .find({ isFeatured: true, visibility: "public" })
      .sort({ createdAt: -1 })
      .limit(12)
      .toArray();

    res.json(lessons);
  } catch (e) {
    res.status(500).json({ message: e.message || "Failed to load featured lessons" });
  }
});
// GET /home/most-saved
app.get("/home/most-saved", async (req, res) => {
  try {
    if (!dbReady) return res.status(503).json({ message: "DB not ready" });

    const rows = await favoritesCollection
      .aggregate([
        { $group: { _id: "$lessonId", saves: { $sum: 1 } } },
        { $sort: { saves: -1 } },
        { $limit: 12 },

        // safer conversion (won’t crash on bad ids)
        {
          $addFields: {
            lessonObjId: {
              $convert: { input: "$_id", to: "objectId", onError: null, onNull: null },
            },
          },
        },
        { $match: { lessonObjId: { $ne: null } } },

        {
          $lookup: {
            from: "lessons",
            localField: "lessonObjId",
            foreignField: "_id",
            as: "lesson",
          },
        },
        { $unwind: "$lesson" },
        { $match: { "lesson.visibility": "public" } },

        { $project: { _id: 0, lessonId: "$lessonObjId", saves: 1, lesson: 1 } },
      ])
      .toArray();

    res.json(rows);
  } catch (e) {
    res.status(500).json({ message: e.message || "Failed to load most saved lessons" });
  }
});

// GET /home/top-contributors
app.get("/home/top-contributors", async (req, res) => {
  try {
    const since = new Date();
    since.setDate(since.getDate() - 7);

    const rows = await lessonsCollection
      .aggregate([
        { $match: { createdAt: { $gte: since } } },
        { $group: { _id: "$creator.uid", lessons: { $sum: 1 } } },
        { $sort: { lessons: -1 } },
        { $limit: 12 },

        { $lookup: { from: "users", localField: "_id", foreignField: "uid", as: "user" } },
        { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },

        {
          $project: {
            _id: 0,
            uid: "$_id",
            lessons: 1,
            name: "$user.name",
            email: "$user.email",
            photoURL: "$user.photoURL",
          },
        },
      ])
      .toArray();

    res.json(rows);
  } catch (e) {
    res.status(500).json({ message: e.message || "Failed to load top contributors" });
  }
});
/* USERS*/

app.post("/users/upsert", async (req, res) => {
  try {
    if (!dbReady) return res.status(503).json({ message: "DB not ready" });

    const { uid, email, name, photoURL } = req.body;
    if (!uid || !email) return res.status(400).json({ message: "uid & email required" });

    const now = new Date();
    const result = await usersCollection.updateOne(
      { uid },
      {
        $set: { uid, email, name: name || "", photoURL: photoURL || "", updatedAt: now },
        $setOnInsert: { role: "user", isPremium: false, createdAt: now },
      },
      { upsert: true }
    );

    res.json({ success: true, result });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

app.get("/users/plan/:uid", async (req, res) => {
  try {
    if (!dbReady) return res.status(503).json({ message: "DB not ready" });

    const uid = req.params.uid;
    const user = await usersCollection.findOne(
      { uid },
      { projection: { isPremium: 1, role: 1, email: 1, name: 1, photoURL: 1 } }
    );

    if (!user) return res.json({ isPremium: false, role: "user", user: null });

    res.json({ isPremium: !!user.isPremium, role: user.role || "user", user });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

/* -----LESSONS------------------- */

app.post("/lessons", async (req, res) => {
  try {
    if (!dbReady) return res.status(503).json({ message: "DB not ready" });

    const lesson = req.body;
    if (!lesson?.title || !lesson?.description || !lesson?.creator?.uid) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const now = new Date();
    const doc = { ...lesson, likes: [], likesCount: 0, createdAt: now, updatedAt: now };
    const result = await lessonsCollection.insertOne(doc);

    res.json({ success: true, insertedId: result.insertedId });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

/* -------------------- Start Server -------------------- */
app.listen(port, () => console.log(`✅ Server listening on port ${port}`));
