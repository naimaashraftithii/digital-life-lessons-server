require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion } = require("mongodb");

const app = express();
const port = process.env.PORT || 3000;

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
}
run();

app.listen(port, () => {
  console.log(`✅ Server listening on port ${port}`);
});
