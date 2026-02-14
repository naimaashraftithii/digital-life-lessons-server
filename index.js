// server/index.js
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

const app = express();

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

/* -------------------- Helpers -------------------- */
const FALLBACK_AVATAR = "https://i.ibb.co/ZxK3f6K/user.png";

function safeObjectId(id) {
  try {
    if (!id) return null;
    if (!ObjectId.isValid(id)) return null;
    return new ObjectId(id);
  } catch {
    return null;
  }
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/* -------------------- Stripe Webhook (MUST be before express.json) -------------------- */
app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    if (!dbReady) return res.status(503).json({ message: "DB not ready yet" });

    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
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

        console.log("✔ Premium activated for uid:", uid);
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
        "http://localhost:5000",
      ].filter(Boolean);

      if (!origin) return cb(null, true);
      if (allowed.includes(origin)) return cb(null, true);

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
  console.log("✔ MongoDB connected");
}

run().catch((err) => {
  dbReady = false;
  console.log("❌ Mongo connect error:", err.message);
});

/*  Basic Routes  */
app.get("/", (req, res) => res.send("✔ Digital Life Lessons Server Running"));

app.get("/health", async (req, res) => {
  try {
    const db = client.db(process.env.DB_NAME);
    const ping = await db.command({ ping: 1 });
    res.json({ ok: true, ping });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

/* USERS */

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


// GET /users/plan?uid=...
app.get("/users/plan", async (req, res) => {
  try {
    if (!dbReady) return res.status(503).json({ message: "DB not ready" });

    const uid = String(req.query.uid || "");
    if (!uid) return res.status(400).json({ message: "uid is required" });

    const user = await usersCollection.findOne(
      { uid },
      { projection: { _id: 0, uid: 1, email: 1, name: 1, photoURL: 1, isPremium: 1, role: 1 } }
    );

    if (!user) return res.status(404).json({ message: "User not found" });

    res.json({
      isPremium: !!user.isPremium,
      role: user.role || "user",
      user,
    });
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

/* LESSONS */

// CREATE lesson 
app.post("/lessons", async (req, res) => {
  try {
    if (!dbReady) return res.status(503).json({ message: "DB not ready" });

    const lesson = req.body;
    if (!lesson?.title || !lesson?.description || !lesson?.creator?.uid) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const now = new Date();

    const visibility = String(lesson.visibility || "public").toLowerCase();
    const accessLevel = String(lesson.accessLevel || "free").toLowerCase();

    const tone = lesson.tone || lesson.emotionalTone || "";
    const category = lesson.category || "General";

    const creator = {
      uid: lesson.creator.uid,
      name: lesson.creator.name || "Unknown",
      email: lesson.creator.email || "",
      photoURL: lesson.creator.photoURL || lesson.creator.photoUrl || "",
    };

    const doc = {
      ...lesson,
      creator,
      category,
      tone,
      emotionalTone: tone, 
      visibility,
      accessLevel,
      likes: [],
      likesCount: 0,
      isFeatured: !!lesson.isFeatured,
      isReviewed: !!lesson.isReviewed,
      createdAt: now,
      updatedAt: now,
    };

    const result = await lessonsCollection.insertOne(doc);
    res.json({ success: true, insertedId: result.insertedId });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// MY lessons
app.get("/lessons/my", async (req, res) => {
  try {
    if (!dbReady) return res.status(503).json({ message: "DB not ready" });

    const { uid } = req.query;
    if (!uid) return res.status(400).json({ message: "uid required" });

    const lessons = await lessonsCollection
      .find({ "creator.uid": uid })
      .sort({ createdAt: -1 })
      .toArray();

    res.json(lessons);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// PUBLIC lessons 
app.get("/lessons/public", async (req, res) => {
  try {
    if (!dbReady) return res.status(503).json({ message: "DB not ready" });

    const { search = "", category = "", tone = "" } = req.query;

    const page = Math.max(1, parseInt(req.query.page || "1", 10));
    const limit = Math.max(1, Math.min(50, parseInt(req.query.limit || "9", 10)));
    const skip = (page - 1) * limit;

    const query = {
      $or: [
        { visibility: { $regex: /^public$/i } },
        { visibility: { $exists: false } },
      ],
    };

    if (category) query.category = category;

    if (tone) {
      
      query.$and = query.$and || [];
      query.$and.push({
        $or: [{ tone }, { emotionalTone: tone }],
      });
    }

    if (search) {
      query.$and = query.$and || [];
      query.$and.push({
        $or: [
          { title: { $regex: search, $options: "i" } },
          { description: { $regex: search, $options: "i" } },
        ],
      });
    }

    const total = await lessonsCollection.countDocuments(query);

    const lessons = await lessonsCollection
      .find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    res.json({
      lessons,
      total,
      currentPage: page,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// SINGLE lesson
app.get("/lessons/:id", async (req, res) => {
  try {
    if (!dbReady) return res.status(503).json({ message: "DB not ready" });

    const oid = safeObjectId(req.params.id);
    if (!oid) return res.status(400).json({ message: "Invalid lesson id" });

    const lesson = await lessonsCollection.findOne({ _id: oid });
    if (!lesson) return res.status(404).json({ message: "Lesson not found" });

    res.json(lesson);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// UPDATE lesson
app.patch("/lessons/:id", async (req, res) => {
  try {
    const oid = safeObjectId(req.params.id);
    if (!oid) return res.status(400).json({ message: "Invalid lesson id" });

    const update = { ...req.body, updatedAt: new Date() };
    await lessonsCollection.updateOne({ _id: oid }, { $set: update });

    const updated = await lessonsCollection.findOne({ _id: oid });
    res.json(updated);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// DELETE lesson (user delete)
app.delete("/lessons/:id", async (req, res) => {
  try {
    const oid = safeObjectId(req.params.id);
    if (!oid) return res.status(400).json({ message: "Invalid lesson id" });

    const idStr = oid.toString();

    await lessonsCollection.deleteOne({ _id: oid });
    await favoritesCollection.deleteMany({ lessonId: idStr });
    await lessonReportsCollection.deleteMany({ lessonId: idStr });
    await commentsCollection.deleteMany({ lessonId: idStr });

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// VISIBILITY
app.patch("/lessons/:id/visibility", async (req, res) => {
  try {
    const oid = safeObjectId(req.params.id);
    if (!oid) return res.status(400).json({ message: "Invalid lesson id" });

    const visibility = String(req.body.visibility || "").toLowerCase();
    if (!["public", "private"].includes(visibility)) {
      return res.status(400).json({ message: "visibility must be public/private" });
    }

    await lessonsCollection.updateOne(
      { _id: oid },
      { $set: { visibility, updatedAt: new Date() } }
    );

    res.json({ success: true, visibility });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ACCESS
app.patch("/lessons/:id/access", async (req, res) => {
  try {
    const oid = safeObjectId(req.params.id);
    if (!oid) return res.status(400).json({ message: "Invalid lesson id" });

    const accessLevel = String(req.body.accessLevel || "").toLowerCase();
    if (!["free", "premium"].includes(accessLevel)) {
      return res.status(400).json({ message: "accessLevel must be free/premium" });
    }

    await lessonsCollection.updateOne(
      { _id: oid },
      { $set: { accessLevel, updatedAt: new Date() } }
    );

    res.json({ success: true, accessLevel });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// LIKE toggle
app.patch("/lessons/:id/like", async (req, res) => {
  try {
    const { uid } = req.body;
    if (!uid) return res.status(400).json({ message: "uid required" });

    const oid = safeObjectId(req.params.id);
    if (!oid) return res.status(400).json({ message: "Invalid lesson id" });

    const lesson = await lessonsCollection.findOne({ _id: oid });
    if (!lesson) return res.status(404).json({ message: "Lesson not found" });

    const alreadyLiked = Array.isArray(lesson.likes) && lesson.likes.includes(uid);

    const update = alreadyLiked
      ? { $pull: { likes: uid }, $inc: { likesCount: -1 }, $set: { updatedAt: new Date() } }
      : { $addToSet: { likes: uid }, $inc: { likesCount: 1 }, $set: { updatedAt: new Date() } };

    await lessonsCollection.updateOne({ _id: oid }, update);

    const updated = await lessonsCollection.findOne(
      { _id: oid },
      { projection: { likesCount: 1 } }
    );

    res.json({ likesCount: updated?.likesCount || 0 });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// FAVORITES COUNT
app.get("/lessons/:id/favorites-count", async (req, res) => {
  try {
    const lessonId = req.params.id;
    const count = await favoritesCollection.countDocuments({ lessonId });
    res.json({ favoritesCount: count });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// SIMILAR lessons

app.get("/lessons/:id/similar", async (req, res) => {
  try {
    const oid = safeObjectId(req.params.id);
    if (!oid) return res.status(400).json({ message: "Invalid lesson id" });

    const current = await lessonsCollection.findOne({ _id: oid });
    if (!current) return res.json([]);

    const visibilityOr = {
      $or: [
        { visibility: { $regex: /^public$/i } },
        { visibility: { $exists: false } },
      ],
    };

    const similarityOr = {
      $or: [
        { category: current.category },
        { tone: current.tone },
        { emotionalTone: current.tone },
      ],
    };

    const query = {
      _id: { $ne: oid },
      $and: [visibilityOr, similarityOr],
    };

    const similar = await lessonsCollection
      .find(query)
      .sort({ createdAt: -1 })
      .limit(6)
      .toArray();

    res.json(similar);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});



/* FAVORITES */

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

/*  COMMENTS */

app.get("/comments", async (req, res) => {
  try {
    const { lessonId } = req.query;
    if (!lessonId) return res.json([]);

    const rows = await commentsCollection.find({ lessonId }).sort({ createdAt: -1 }).toArray();
    res.json(rows);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

app.post("/comments", async (req, res) => {
  try {
    const body = req.body;
    if (!body?.lessonId || !body?.uid || !body?.text) {
      return res.status(400).json({ message: "lessonId, uid, text required" });
    }

    const doc = { ...body, createdAt: new Date() };
    const result = await commentsCollection.insertOne(doc);

    res.json({ success: true, insertedId: result.insertedId });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

app.delete("/comments/:id", async (req, res) => {
  try {
    const { uid } = req.query;
    const oid = safeObjectId(req.params.id);
    if (!uid) return res.status(400).json({ message: "uid required" });
    if (!oid) return res.status(400).json({ message: "Invalid comment id" });

    const comment = await commentsCollection.findOne({ _id: oid });
    if (!comment) return res.status(404).json({ message: "Not found" });
    if (comment.uid !== uid) return res.status(403).json({ message: "Forbidden" });

    await commentsCollection.deleteOne({ _id: oid });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

/* STRIPE CHECKOUT */
app.post("/payments/confirm", async (req, res) => {
  try {
    if (!dbReady) return res.status(503).json({ message: "DB not ready" });

    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ message: "sessionId required" });

    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.payment_status !== "paid") {
      return res.status(400).json({ message: "Payment not completed yet" });
    }

    const uid = session?.metadata?.uid;
    const email = session?.metadata?.email || session.customer_email;

    if (!uid) return res.status(400).json({ message: "No uid in session metadata" });

    await usersCollection.updateOne(
      { uid },
      { $set: { isPremium: true, updatedAt: new Date() } }
    );

    await paymentsCollection.updateOne(
      { stripeSessionId: session.id },
      {
        $setOnInsert: {
          uid,
          email,
          stripeSessionId: session.id,
          stripePaymentIntentId: session.payment_intent,
          amount: session.amount_total,
          currency: session.currency,
          status: "paid",
          createdAt: new Date()
        }
      },
      { upsert: true }
    );

    return res.json({ ok: true, isPremium: true });
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
});


app.post("/create-checkout-session", async (req, res) => {
  try {
    if (!dbReady) return res.status(503).json({ message: "DB not ready" });

    const { uid, email } = req.body;
    if (!uid || !email) return res.status(400).json({ message: "uid & email required" });

    const user = await usersCollection.findOne({ uid });
    if (!user) return res.status(404).json({ message: "User not found. Upsert first." });
    if (user.isPremium) return res.status(400).json({ message: "Already premium" });

   
    const clientUrl =
      req.headers.origin ||
      process.env.CLIENT_URL ||
      "http://localhost:5173";

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      customer_email: email,
      line_items: [
        {
          price_data: {
            currency: "bdt",
            product_data: {
              name: "Digital Life Lessons — Premium (Lifetime)",
              description: "One-time payment for lifetime premium access.",
            },
            unit_amount: 1500 * 100,
          },
          quantity: 1,
        },
      ],
      metadata: { uid, email },

   
      success_url: `${clientUrl}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${clientUrl}/payment-cancel`,
    });

    res.json({ url: session.url });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});


/*  REPORTS */

app.post("/lessonReports", async (req, res) => {
  try {
    if (!dbReady) return res.status(503).json({ message: "DB not ready" });

    const { lessonId, reporterUid, reporterEmail, reason } = req.body;

    if (!lessonId || (!reporterUid && !reporterEmail) || !reason) {
      return res.status(400).json({ message: "Missing report fields" });
    }

    await lessonReportsCollection.insertOne({
      lessonId: String(lessonId),
      reporterUid: reporterUid || null,
      reporterEmail: reporterEmail || null,
      reason: String(reason),
      createdAt: new Date(),
    });

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

/* DASHBOARD SUMMARY  */

    app.get("/dashboard/summary", async (req, res) => {
  try {
    if (!dbReady) return res.status(503).json({ message: "DB not ready" });

    const uid = req.query.uid;
    if (!uid) return res.status(400).json({ message: "uid required" });

    const user = await usersCollection.findOne({ uid });
    if (!user) return res.status(404).json({ message: "User not found" });

    const lessons = await lessonsCollection
      .find({ "creator.uid": uid })
      .project({ title: 1, description: 1, createdAt: 1, visibility: 1, likesCount: 1 })
      .toArray();

    const lessonIdsStr = lessons.map((l) => String(l._id));

    const favorites = await favoritesCollection.countDocuments({ uid });

    const likes = lessons.reduce((sum, l) => sum + (Number(l.likesCount) || 0), 0);
    const publicLessons = lessons.filter((l) => l.visibility === "public").length;

    const reports = await lessonReportsCollection.countDocuments({
      lessonId: { $in: lessonIdsStr }
    });

    const comments = await commentsCollection.countDocuments({
      lessonId: { $in: lessonIdsStr }
    });

    res.json({
      user: {
        uid: user.uid,
        name: user.name,
        email: user.email,
        photoURL: user.photoURL,
        role: user.role || "user",
        isPremium: !!user.isPremium
      },
      counts: {
        publicLessons,
        favorites,
        likes,
        reports,
        comments
      }
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

    

/*ADMIN ROUTES*/

// ADMIN SUMMARY
function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function formatMMDD(d) {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}-${dd}`;
}

app.get("/admin/summary", async (req, res) => {
  try {
    if (!dbReady) return res.status(503).json({ message: "DB not ready" });

    const today = startOfDay(new Date());
    const start = new Date(today);
    start.setDate(today.getDate() - 6);

    const [
      totalUsers,
      totalPublicLessons,
      totalPrivateLessons,
      totalReports,
      todaysNewLessons,
    ] = await Promise.all([
      usersCollection.countDocuments({}),
      lessonsCollection.countDocuments({ visibility: { $regex: /^public$/i } }),
      lessonsCollection.countDocuments({ visibility: { $regex: /^private$/i } }),
      lessonReportsCollection.countDocuments({}),
      lessonsCollection.countDocuments({ createdAt: { $gte: today } }),
    ]);

    // series: last 7 days 
    const agg = await lessonsCollection
      .aggregate([
        { $match: { createdAt: { $gte: start } } },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
            lessons: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ])
      .toArray();

    const map = new Map(agg.map((x) => [x._id, x.lessons]));
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      days.push({
        day: formatMMDD(d),
        lessons: map.get(key) || 0,
      });
    }

    // top contributors 
    const topContributors = await lessonsCollection
      .aggregate([
        { $match: { visibility: { $regex: /^public$/i }, createdAt: { $gte: start } } },
        { $group: { _id: "$creator.uid", lessons: { $sum: 1 } } },
        { $sort: { lessons: -1 } },
        { $limit: 8 },
        { $lookup: { from: "users", localField: "_id", foreignField: "uid", as: "user" } },
        { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
        {
          $project: {
            _id: 0,
            uid: "$_id",
            lessons: 1,
            name: { $ifNull: ["$user.name", "Unknown"] },
            photoURL: { $ifNull: ["$user.photoURL", "https://i.ibb.co/ZxK3f6K/user.png"] },
          },
        },
      ])
      .toArray();

    res.json({
      counts: { totalUsers, totalPublicLessons, totalPrivateLessons, totalReports, todaysNewLessons },
      series: days,
      topContributors,
      topMode: "last7days",
    });
  } catch (e) {
    res.status(500).json({ message: e.message || "Failed to load admin summary" });
  }
});


// ADMIN USERS
app.get("/admin/users", async (req, res) => {
  try {
    if (!dbReady) return res.status(503).json({ message: "DB not ready" });

    const rows = await usersCollection
      .aggregate([
        {
          $lookup: {
            from: "lessons",
            let: { uid: "$uid" },
            pipeline: [
              { $match: { $expr: { $eq: ["$creator.uid", "$$uid"] } } },
              { $count: "lessonsCreated" },
            ],
            as: "lessonStats",
          },
        },
        {
          $addFields: {
            lessonsCreated: { $ifNull: [{ $first: "$lessonStats.lessonsCreated" }, 0] },
          },
        },
        {
          $project: {
            _id: 0,
            uid: 1,
            email: 1,
            name: 1,
            photoURL: 1,
            role: 1,
            isPremium: 1,
            lessonsCreated: 1,
          },
        },
        { $sort: { createdAt: -1 } },
      ])
      .toArray();

    res.json(rows);
  } catch (e) {
    res.status(500).json({ message: e.message || "Failed to load users" });
  }
});

app.patch("/admin/users/role", async (req, res) => {
  try {
    if (!dbReady) return res.status(503).json({ message: "DB not ready" });

    const { uid, role } = req.body;
    if (!uid || !["admin", "user"].includes(role)) {
      return res.status(400).json({ message: "uid and role(admin/user) required" });
    }

    await usersCollection.updateOne({ uid }, { $set: { role, updatedAt: new Date() } });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ message: e.message || "Failed to update role" });
  }
});

app.delete("/admin/users/:uid", async (req, res) => {
  try {
    if (!dbReady) return res.status(503).json({ message: "DB not ready" });

    const uid = req.params.uid;
    await usersCollection.deleteOne({ uid });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ message: e.message || "Failed to delete user" });
  }
});

// ADMIN LESSONS
app.get("/admin/lessons", async (req, res) => {
  try {
    if (!dbReady) return res.status(503).json({ message: "DB not ready" });

    const { search = "", visibility = "", accessLevel = "", featured = "" } = req.query;

    const query = {};
    if (visibility) query.visibility = visibility;
    if (accessLevel) query.accessLevel = accessLevel;
    if (featured === "true") query.isFeatured = true;
    if (featured === "false") query.isFeatured = { $ne: true };

    if (search) {
      query.$or = [
        { title: { $regex: search, $options: "i" } },
        { description: { $regex: search, $options: "i" } },
      ];
    }

    const lessons = await lessonsCollection.find(query).sort({ createdAt: -1 }).limit(300).toArray();
    res.json(lessons);
  } catch (e) {
    res.status(500).json({ message: e.message || "Failed to load lessons" });
  }
});

app.patch("/admin/lessons/:id/featured", async (req, res) => {
  try {
    if (!dbReady) return res.status(503).json({ message: "DB not ready" });

    const oid = safeObjectId(req.params.id);
    if (!oid) return res.status(400).json({ message: "Invalid lesson id" });

    const { value } = req.body;
    await lessonsCollection.updateOne(
      { _id: oid },
      { $set: { isFeatured: !!value, updatedAt: new Date() } }
    );

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ message: e.message || "Failed to toggle featured" });
  }
});

app.patch("/admin/lessons/:id/reviewed", async (req, res) => {
  try {
    if (!dbReady) return res.status(503).json({ message: "DB not ready" });

    const oid = safeObjectId(req.params.id);
    if (!oid) return res.status(400).json({ message: "Invalid lesson id" });

    const { value } = req.body;
    await lessonsCollection.updateOne(
      { _id: oid },
      { $set: { isReviewed: !!value, updatedAt: new Date() } }
    );

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ message: e.message || "Failed to toggle reviewed" });
  }
});

app.delete("/admin/lessons/:id", async (req, res) => {
  try {
    if (!dbReady) return res.status(503).json({ message: "DB not ready" });

    const oid = safeObjectId(req.params.id);
    if (!oid) return res.status(400).json({ message: "Invalid lesson id" });

    const idStr = oid.toString();

    await lessonsCollection.deleteOne({ _id: oid });
    await lessonReportsCollection.deleteMany({ lessonId: idStr });
    await favoritesCollection.deleteMany({ lessonId: idStr });
    await commentsCollection.deleteMany({ lessonId: idStr });

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ message: e.message || "Failed to delete lesson" });
  }
});

// ADMIN REPORTED LESSONS
app.get("/admin/reported-lessons", async (req, res) => {
  try {
    if (!dbReady) return res.status(503).json({ message: "DB not ready" });

    const rows = await lessonReportsCollection
      .aggregate([
        {
          $group: {
            _id: "$lessonId",
            reportCount: { $sum: 1 },
            reports: {
              $push: {
                reporterUid: "$reporterUid",
                reporterEmail: "$reporterEmail",
                reason: "$reason",
                createdAt: "$createdAt",
              },
            },
            lastReportAt: { $max: "$createdAt" },
          },
        },
        { $sort: { reportCount: -1, lastReportAt: -1 } },

        {
          $addFields: {
            lessonObjId: {
              $convert: { input: "$_id", to: "objectId", onError: null, onNull: null },
            },
          },
        },

        {
          $lookup: {
            from: "lessons",
            localField: "lessonObjId",
            foreignField: "_id",
            as: "lesson",
          },
        },
        { $unwind: { path: "$lesson", preserveNullAndEmptyArrays: true } },

        {
          $project: {
            _id: 0,
            lessonId: "$_id",
            reportCount: 1,
            lastReportAt: 1,
            reports: 1,
            lesson: {
              _id: "$lesson._id",
              title: "$lesson.title",
              visibility: "$lesson.visibility",
              accessLevel: "$lesson.accessLevel",
              creator: "$lesson.creator",
              createdAt: "$lesson.createdAt",
            },
          },
        },
      ])
      .toArray();

    res.json(rows);
  } catch (e) {
    res.status(500).json({ message: e.message || "Failed to load reported lessons" });
  }
});

app.delete("/admin/reported-lessons/:lessonId", async (req, res) => {
  try {
    if (!dbReady) return res.status(503).json({ message: "DB not ready" });

    const lessonId = String(req.params.lessonId || "");
    if (!lessonId) return res.status(400).json({ message: "lessonId required" });

    await lessonReportsCollection.deleteMany({ lessonId });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ message: e.message || "Failed to ignore reports" });
  }
});

// FEATURED 
app.get("/home/featured", async (req, res) => {
  try {
    if (!dbReady) return res.status(503).json({ message: "DB not ready" });

    const lessons = await lessonsCollection
      .find({ isFeatured: true, visibility: { $regex: /^public$/i } })
      .sort({ createdAt: -1 })
      .limit(6)
      .toArray();

    res.json(lessons);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// MOST SAVED
app.get("/home/most-saved", async (req, res) => {
  try {
    if (!dbReady) return res.status(503).json({ message: "DB not ready" });

    const rows = await favoritesCollection
      .aggregate([
        { $group: { _id: "$lessonId", saves: { $sum: 1 } } },
        { $sort: { saves: -1 } },
        { $limit: 9 },
        { $addFields: { lessonObjId: { $convert: { input: "$_id", to: "objectId", onError: null, onNull: null } } } },
        { $lookup: { from: "lessons", localField: "lessonObjId", foreignField: "_id", as: "lesson" } },
        { $unwind: { path: "$lesson", preserveNullAndEmptyArrays: true } },
        {
          $project: {
            _id: 0,
            lessonId: "$_id",
            saves: 1,
            lesson: 1,
          },
        },
      ])
      .toArray();

    res.json(rows);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// TOP CONTRIBUTORS
app.get("/home/top-contributors", async (req, res) => {
  try {
    if (!dbReady) return res.status(503).json({ message: "DB not ready" });

    const days = Number(req.query.days ?? 7);
    const match = { visibility: { $regex: /^public$/i } };

    if (days > 0) {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      start.setDate(start.getDate() - (days - 1));
      match.createdAt = { $gte: start };
    }

    const rows = await lessonsCollection
      .aggregate([
        { $match: match },
        { $group: { _id: "$creator.uid", lessons: { $sum: 1 } } },
        { $sort: { lessons: -1 } },
        { $limit: 8 },
        { $lookup: { from: "users", localField: "_id", foreignField: "uid", as: "user" } },
        { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
        {
          $project: {
            _id: 0,
            uid: "$_id",
            lessons: 1,
            name: { $ifNull: ["$user.name", "Unknown"] },
            photoURL: { $ifNull: ["$user.photoURL", "https://i.ibb.co/ZxK3f6K/user.png"] },
          },
        },
      ])
      .toArray();

    res.json(rows);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});



/* -------------------- Start Server -------------------- */
const port = process.env.PORT || 3000;
app.listen(port, () => console.log("✔ Server running on port", port));
