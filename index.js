require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion } = require("mongodb");

const app = express();
const port = process.env.PORT || 5000;

app.use(
  cors({
    origin: [process.env.CLIENT_URL],
    credentials: true,
  })
);
app.use(express.json());

const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

let db, usersCollection, lessonsCollection, favoritesCollection, lessonReportsCollection;

async function run() {
  try {
    await client.connect();
    db = client.db(process.env.DB_NAME);

    usersCollection = db.collection("users");
    lessonsCollection = db.collection("lessons");
    favoritesCollection = db.collection("favorites");
    lessonReportsCollection = db.collection("lessonReports");

    console.log("✅ MongoDB connected");

    app.get("/", (req, res) => {
      res.send("✅ Digital Life Lessons Server Running");
    });

    // health check
    app.get("/health", async (req, res) => {
      const ping = await db.command({ ping: 1 });
      res.json({ ok: true, ping });
    });
  } catch (err) {
    console.error("❌ Server failed:", err.message);
  }
  app.get("/users/plan", async (req, res) => {
  try {
    const { uid } = req.query;
    if (!uid) return res.status(400).json({ message: "uid required" });

    const user = await usersCollection.findOne(
      { uid },
      { projection: { isPremium: 1, role: 1, email: 1, name: 1, photoURL: 1 } }
    );

    if (!user) return res.status(404).json({ message: "User not found" });

    res.json({ isPremium: !!user.isPremium, role: user.role || "user", user });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});
app.post("/lessons", async (req, res) => {
  try {
    const lesson = req.body;

    if (!lesson?.title || !lesson?.description || !lesson?.creator?.uid) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const now = new Date();

    const doc = {
      ...lesson,
      likes: [],
      likesCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    const result = await lessonsCollection.insertOne(doc);
    res.json({ success: true, insertedId: result.insertedId });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

  app.post("/users/upsert", async (req, res) => {
  try {
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

  
}
run();

app.listen(port, () => {
  console.log(`✅ Server listening on port ${port}`);
});
