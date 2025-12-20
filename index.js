require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

const app = express();
const port = process.env.PORT || 3000;

/* -------------------- Middlewares -------------------- */
app.use(
  cors({
    origin: [process.env.CLIENT_URL],
    credentials: true,
  })
);
app.use(express.json());

/* -------------------- Firebase Admin (Optional) -------------------- */
// If you don't need verify token now, you can keep FB_SERVICE_KEY empty.
let admin = null;

if (process.env.FB_SERVICE_KEY) {
  try {
    admin = require("firebase-admin");

    const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString("utf8");
    const serviceAccount = JSON.parse(decoded);

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });

    console.log("✅ Firebase Admin Initialized");
  } catch (e) {
    admin = null;
    console.log("⚠️ Firebase Admin NOT initialized:", e.message);
  }
} else {
  console.log("ℹ️ Firebase Admin skipped (FB_SERVICE_KEY empty)");
}

/* -------------------- verifyFBToken Middleware -------------------- */
const verifyFBToken = async (req, res, next) => {
  if (!admin) return res.status(501).send({ message: "Firebase Admin not configured" });

  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).send({ message: "unauthorized" });

  try {
    const token = authHeader.split(" ")[1];
    const decodedUser = await admin.auth().verifyIdToken(token);

    req.decoded = decodedUser; // { email, uid, ... }
    next();
  } catch (err) {
    return res.status(401).send({ message: "unauthorized" });
  }
};

/* -------------------- MongoDB Connect -------------------- */
const pass = encodeURIComponent(process.env.DB_PASSWORD);
const uri = `mongodb+srv://${process.env.DB_USER}:${pass}@cluster0.x6bmi0l.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

let usersCollection, lessonsCollection, favoritesCollection, lessonReportsCollection;

async function run() {
  try {
    await client.connect();
    const db = client.db(process.env.DB_NAME);

    usersCollection = db.collection("users");
    lessonsCollection = db.collection("lessons");
    favoritesCollection = db.collection("favorites");
    lessonReportsCollection = db.collection("lessonReports");

    console.log("✅ MongoDB connected");

    /* -------------------- Basic Routes -------------------- */
    app.get("/", (req, res) => res.send("✅ Digital Life Lessons Server Running"));

    app.get("/health", async (req, res) => {
      const ping = await db.command({ ping: 1 });
      res.json({ ok: true, ping });
    });

    /* -------------------- Users -------------------- */
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

    /* -------------------- Lessons -------------------- */
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

    app.get("/lessons/public", async (req, res) => {
      try {
        const { search = "", category = "", tone = "" } = req.query;

        const query = { visibility: "public" };

        if (category) query.category = category;
        if (tone) query.tone = tone;

        if (search) {
          query.$or = [
            { title: { $regex: search, $options: "i" } },
            { description: { $regex: search, $options: "i" } },
          ];
        }

        const lessons = await lessonsCollection.find(query).sort({ createdAt: -1 }).toArray();
        res.json(lessons);
      } catch (e) {
        res.status(500).json({ message: e.message });
      }
    });

    app.get("/lessons/:id", async (req, res) => {
      try {
        const lesson = await lessonsCollection.findOne({ _id: new ObjectId(req.params.id) });
        if (!lesson) return res.status(404).json({ message: "Lesson not found" });
        res.json(lesson);
      } catch (e) {
        res.status(500).json({ message: e.message });
      }
    });

    /* -------------------- Favorites -------------------- */
    app.post("/favorites/toggle", async (req, res) => {
      try {
        const { uid, lessonId } = req.body;
        if (!uid || !lessonId) return res.status(400).json({ message: "uid & lessonId required" });

        const exists = await favoritesCollection.findOne({ uid, lessonId });

        if (exists) {
          await favoritesCollection.deleteOne({ uid, lessonId });
          return res.json({ saved: false });
        }

        await favoritesCollection.insertOne({ uid, lessonId, createdAt: new Date() });
        res.json({ saved: true });
      } catch (e) {
        res.status(500).json({ message: e.message });
      }
    });

    app.get("/favorites", async (req, res) => {
      try {
        const { uid } = req.query;
        if (!uid) return res.status(400).json({ message: "uid required" });

        const favs = await favoritesCollection.find({ uid }).sort({ createdAt: -1 }).toArray();
        res.json(favs);
      } catch (e) {
        res.status(500).json({ message: e.message });
      }
    });

    /* -------------------- Reports -------------------- */
    app.post("/lessonReports", async (req, res) => {
      try {
        const { lessonId, reporterUid, reporterEmail, reason } = req.body;

        if (!lessonId || (!reporterUid && !reporterEmail) || !reason) {
          return res.status(400).json({ message: "Missing report fields" });
        }

        await lessonReportsCollection.insertOne({
          lessonId,
          reporterUid: reporterUid || null,
          reporterEmail: reporterEmail || null,
          reason,
          createdAt: new Date(),
        });

        res.json({ success: true });
      } catch (e) {
        res.status(500).json({ message: e.message });
      }
    });

    /* -------------------- Private Test (optional) -------------------- */
    // app.get("/private-test", verifyFBToken, (req, res) => {
    //   res.send({ message: "✅ Token verified", user: req.decoded });
    // });

  } catch (err) {
    console.log("❌ Mongo connect error:", err.message);
  }
}

run().catch(console.dir);

app.listen(port, () => {
  console.log(`✅ Server listening on port ${port}`);
});
