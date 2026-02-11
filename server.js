require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const Stripe = require("stripe");

const app = express();
const port = process.env.PORT || 3000;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);


// CORS

app.use(
  cors({
    origin: [process.env.CLIENT_URL],
    credentials: true,
  })
);


// Stripe Webhook 

app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  let event;

  try {
    const sig = req.headers["stripe-signature"];
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("❌ Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      const uid = session?.metadata?.uid;
      const email =
        session?.metadata?.email ||
        session?.customer_details?.email ||
        session?.customer_email;

      if (uid && global.usersCollection) {
        await global.usersCollection.updateOne(
          { uid },
          {
            $set: {
              isPremium: true,
              premiumSince: new Date(),
              premiumEmail: email || null,
              updatedAt: new Date(),
            },
          }
        );

        if (global.paymentsCollection) {
          const exists = await global.paymentsCollection.findOne({ stripeSessionId: session.id });
          if (!exists) {
            await global.paymentsCollection.insertOne({
              uid,
              email: email || null,
              stripeSessionId: session.id,
              stripePaymentIntentId: session.payment_intent || null,
              amountTotal: session.amount_total || null,
              currency: session.currency || null,
              status: "paid",
              createdAt: new Date(),
            });
          }
        }

        console.log("✅ Premium activated for:", uid);
      } else {
        console.log("⚠️ Missing uid or DB not ready");
      }
    }

    return res.json({ received: true });
  } catch (e) {
    console.error("❌ Webhook handler error:", e.message);
    return res.status(500).json({ message: e.message });
  }
});


// JSON  

app.use(express.json());


// MongoDB

const pass = encodeURIComponent(process.env.DB_PASSWORD);
const uri = `mongodb+srv://${process.env.DB_USER}:${pass}@cluster0.x6bmi0l.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
});

async function run() {
  await client.connect();
  const db = client.db(process.env.DB_NAME);

  // Global access for webhook
  global.usersCollection = db.collection("users");
  global.paymentsCollection = db.collection("payments");

  // App collections
  const lessonsCollection = db.collection("lessons");
  const favoritesCollection = db.collection("favorites");
  const lessonReportsCollection = db.collection("lessonReports");
  const commentsCollection = db.collection("comments");

  console.log("✅ MongoDB connected");


  // Basic

  app.get("/", (req, res) => res.send("✅ Digital Life Lessons Server Running"));

  app.get("/health", async (req, res) => {
    // const ping = await db.command({ ping: 1 });
    res.json({ ok: true, ping });
  });

  // Users

  app.post("/users/upsert", async (req, res) => {
    try {
      const { uid, email, name, photoURL } = req.body;
      if (!uid || !email) return res.status(400).json({ message: "uid & email required" });

      const now = new Date();

      const result = await global.usersCollection.updateOne(
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

      const user = await global.usersCollection.findOne(
        { uid },
        { projection: { isPremium: 1, role: 1, email: 1, name: 1, photoURL: 1, premiumSince: 1 } }
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


  // Stripe Checkout

  // ✅ Stripe Webhook (MUST be before express.json)
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

    // ✅ Handle success
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      const uid = session?.metadata?.uid;
      const email = session?.metadata?.email || session.customer_email;

      if (uid) {
        // ✅ Premium true
        await usersCollection.updateOne(
          { uid },
          { $set: { isPremium: true, updatedAt: new Date() } }
        );

        // ✅ idempotent payment record
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
              createdAt: new Date(),
            },
          },
          { upsert: true }
        );

        console.log("✅ Premium activated by webhook for uid:", uid);
      }
    }

    return res.json({ received: true });
  } catch (e) {
    console.error("❌ Webhook handler error:", e.message);
    return res.status(500).json({ message: e.message });
  }
});

// ✅ NOW normal json middleware
app.use(express.json());

// -------------------- USERS --------------------

// ✅ upsert user (called after Firebase login)
app.post("/users/upsert", async (req, res) => {
  try {
    if (!dbReady) return res.status(503).json({ message: "DB not ready" });

    const { uid, email, name, photoURL } = req.body;
    if (!uid || !email) return res.status(400).json({ message: "uid & email required" });

    const update = {
      $set: {
        uid,
        email,
        name: name || "",
        photoURL: photoURL || "",
        updatedAt: new Date(),
      },
      $setOnInsert: {
        role: "user",
        isPremium: false,
        createdAt: new Date(),
      },
    };

    await usersCollection.updateOne({ uid }, update, { upsert: true });
    const user = await usersCollection.findOne({ uid }, { projection: { _id: 0 } });

    res.json(user);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ✅ plan endpoint (single source of truth)
app.get("/users/plan", async (req, res) => {
  try {
    if (!dbReady) return res.status(503).json({ message: "DB not ready" });

    const uid = req.query.uid;
    if (!uid) return res.status(400).json({ message: "uid required" });

    const user = await usersCollection.findOne({ uid }, { projection: { _id: 0 } });
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

// -------------------- STRIPE --------------------

// ✅ create checkout session
app.post("/create-checkout-session", async (req, res) => {
  try {
    if (!dbReady) return res.status(503).json({ message: "DB not ready" });

    const { uid, email } = req.body;
    if (!uid || !email) return res.status(400).json({ message: "uid & email required" });

    const user = await usersCollection.findOne({ uid });
    if (!user) return res.status(404).json({ message: "User not found. Upsert first." });
    if (user.isPremium) return res.status(400).json({ message: "Already premium" });

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
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
      success_url: `${process.env.CLIENT_URL}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.CLIENT_URL}/payment-cancel`,
    });

    res.json({ url: session.url });
  } catch (e) {
    console.error("❌ create-checkout-session:", e.message);
    res.status(500).json({ message: e.message });
  }
});

// ✅ optional confirm route (fallback if webhook delay)
app.post("/payments/confirm", async (req, res) => {
  try {
    if (!dbReady) return res.status(503).json({ message: "DB not ready" });

    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ message: "sessionId required" });

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const paid = session?.payment_status === "paid";

    const uid = session?.metadata?.uid;
    const email = session?.metadata?.email || session.customer_email;

    if (paid && uid) {
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
            createdAt: new Date(),
          },
        },
        { upsert: true }
      );
    }

    res.json({ ok: true, paid, uid });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

  // app.post("/create-checkout-session", async (req, res) => {
  //   try {
  //     const { uid, email } = req.body;
  //     if (!uid || !email) return res.status(400).json({ message: "uid & email required" });

  //     const user = await global.usersCollection.findOne({ uid });
  //     if (!user) return res.status(404).json({ message: "User not found. Upsert first." });
  //     if (user.isPremium) return res.status(400).json({ message: "Already premium" });

  
  //     const session = await stripe.checkout.sessions.create({
  //       mode: "payment",
  //       payment_method_types: ["card"],
  //       customer_email: email,
  //       line_items: [
  //         {
  //           price_data: {
  //             currency: "bdt",
  //             product_data: {
  //               name: "Digital Life Lessons — Lifetime Premium",
  //               description: "One-time payment for lifetime premium access.",
  //             },
  //             unit_amount: 1500 * 100,
  //           },
  //           quantity: 1,
  //         },
  //       ],
  //       metadata: { uid, email },
  //       success_url: `${process.env.CLIENT_URL}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
  //       cancel_url: `${process.env.CLIENT_URL}/payment-cancel`,
  //     });

  //     res.json({ url: session.url });
  //   } catch (e) {
  //     res.status(500).json({ message: e.message });
  //   }
  // });

  // // Confirm payment fallback 
  // app.post("/payments/confirm", async (req, res) => {
  //   try {
  //     const { sessionId } = req.body;
  //     if (!sessionId) return res.status(400).json({ message: "sessionId required" });

  //     const session = await stripe.checkout.sessions.retrieve(sessionId);
  //     const paid = session?.payment_status === "paid";
  //     if (!paid) return res.status(400).json({ message: "Payment not completed" });

  //     const uid = session?.metadata?.uid;
  //     const email =
  //       session?.metadata?.email ||
  //       session?.customer_details?.email ||
  //       session?.customer_email;

  //     if (!uid) return res.status(400).json({ message: "uid missing in session metadata" });

  //     await global.usersCollection.updateOne(
  //       { uid },
  //       { $set: { isPremium: true, premiumSince: new Date(), premiumEmail: email || null, updatedAt: new Date() } }
  //     );

  //     const exists = await global.paymentsCollection.findOne({ stripeSessionId: session.id });
  //     if (!exists) {
  //       await global.paymentsCollection.insertOne({
  //         uid,
  //         email: email || null,
  //         stripeSessionId: session.id,
  //         stripePaymentIntentId: session.payment_intent || null,
  //         amountTotal: session.amount_total || null,
  //         currency: session.currency || null,
  //         status: "paid",
  //         createdAt: new Date(),
  //       });
  //     }

  //     res.json({ success: true, isPremium: true });
  //   } catch (e) {
  //     res.status(500).json({ message: e.message });
  //   }
  // });


  // Lessons

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
        isFeatured: false,
        isReviewed: false,
        createdAt: now,
        updatedAt: now,
      };

      const result = await lessonsCollection.insertOne(doc);
      res.json({ success: true, insertedId: result.insertedId });
    } catch (e) {
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/lessons/my", async (req, res) => {
    try {
      const { uid } = req.query;
      if (!uid) return res.status(400).json({ message: "uid required" });

      const lessons = await lessonsCollection.find({ "creator.uid": uid }).sort({ createdAt: -1 }).toArray();
      res.json(lessons);
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

  app.get("/lessons/featured", async (req, res) => {
    try {
      const lessons = await lessonsCollection
        .find({ visibility: "public", isFeatured: true })
        .sort({ createdAt: -1 })
        .limit(6)
        .toArray();

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
  app.patch("/lessons/:id/like", async (req, res) => {
  try {
    const { id } = req.params;
    const { uid } = req.body;
    if (!uid) return res.status(400).json({ message: "uid required" });

    const lesson = await lessonsCollection.findOne({ _id: new ObjectId(id) });
    if (!lesson) return res.status(404).json({ message: "Lesson not found" });

    const likes = Array.isArray(lesson.likes) ? lesson.likes : [];
    const hasLiked = likes.includes(uid);

    const update = hasLiked
      ? { $pull: { likes: uid }, $inc: { likesCount: -1 }, $set: { updatedAt: new Date() } }
      : { $addToSet: { likes: uid }, $inc: { likesCount: 1 }, $set: { updatedAt: new Date() } };

    await lessonsCollection.updateOne({ _id: new ObjectId(id) }, update);

    const updated = await lessonsCollection.findOne(
      { _id: new ObjectId(id) },
      { projection: { likesCount: 1, likes: 1 } }
    );

    res.json({ liked: !hasLiked, likesCount: updated.likesCount || 0 });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});
//Similar Lessons -6 cards
app.get("/lessons/similar/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const current = await lessonsCollection.findOne({ _id: new ObjectId(id) });
    if (!current) return res.status(404).json({ message: "Lesson not found" });

    const query = {
      visibility: "public",
      _id: { $ne: new ObjectId(id) },
      $or: [{ category: current.category }, { tone: current.tone }],
    };

    const lessons = await lessonsCollection.find(query).sort({ createdAt: -1 }).limit(6).toArray();
    res.json(lessons);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});
//Admin reported lesons
app.get("/admin/reported-lessons", async (req, res) => {
  try {
    const agg = await lessonReportsCollection
      .aggregate([
        {
          $group: {
            _id: "$lessonId",
            reportCount: { $sum: 1 },
            reasons: {
              $push: {
                reason: "$reason",
                reporterUid: "$reporterUid",
                reporterEmail: "$reporterEmail",
                createdAt: "$createdAt",
              },
            },
          },
        },
        { $sort: { reportCount: -1 } },
      ])
      .toArray();

    const ids = agg.map((x) => new ObjectId(x._id));
    const lessons = await lessonsCollection
      .find({ _id: { $in: ids } }, { projection: { title: 1, creator: 1, createdAt: 1 } })
      .toArray();

    const map = {};
    lessons.forEach((l) => (map[String(l._id)] = l));

    const merged = agg.map((r) => ({
      lessonId: r._id,
      reportCount: r.reportCount,
      reasons: r.reasons,
      lesson: map[r._id] || null,
    }));

    res.json(merged);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

app.get("/admin/reported-lessons", async (req, res) => {
  try {
    const agg = await lessonReportsCollection
      .aggregate([
        {
          $group: {
            _id: "$lessonId",
            reportCount: { $sum: 1 },
            reasons: {
              $push: {
                reason: "$reason",
                reporterUid: "$reporterUid",
                reporterEmail: "$reporterEmail",
                createdAt: "$createdAt",
              },
            },
          },
        },
        { $sort: { reportCount: -1 } },
      ])
      .toArray();

    const ids = agg.map((x) => new ObjectId(x._id));
    const lessons = await lessonsCollection
      .find({ _id: { $in: ids } }, { projection: { title: 1, creator: 1, createdAt: 1 } })
      .toArray();

    const map = {};
    lessons.forEach((l) => (map[String(l._id)] = l));

    const merged = agg.map((r) => ({
      lessonId: r._id,
      reportCount: r.reportCount,
      reasons: r.reasons,
      lesson: map[r._id] || null,
    }));

    res.json(merged);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});


//Admin-Ignore reports 
app.delete("/admin/reported-lessons/:lessonId", async (req, res) => {
  try {
    const { lessonId } = req.params;
    await lessonReportsCollection.deleteMany({ lessonId });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});


  // Favorites

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
app.get("/lessons/:id/favorites-count", async (req, res) => {
  try {
    const { id } = req.params;
    const count = await favoritesCollection.countDocuments({ lessonId: id });
    res.json({ favoritesCount: count });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});
app.get("/favorites/lessons", async (req, res) => {
  try {
    const { uid } = req.query;
    if (!uid) return res.status(400).json({ message: "uid required" });

    const favs = await favoritesCollection.find({ uid }).sort({ createdAt: -1 }).toArray();
    const ids = favs.map((f) => new ObjectId(f.lessonId)).filter(Boolean);

    if (!ids.length) return res.json([]);

    const lessons = await lessonsCollection
      .find({ _id: { $in: ids } })
      .sort({ createdAt: -1 })
      .toArray();

    const map = {};
    lessons.forEach((l) => (map[String(l._id)] = l));
    const ordered = favs.map((f) => map[f.lessonId]).filter(Boolean);

    res.json(ordered);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

//Comments


app.get("/comments", async (req, res) => {
  try {
    const { lessonId } = req.query;
    if (!lessonId) return res.status(400).json({ message: "lessonId required" });

    const comments = await commentsCollection
      .find({ lessonId })
      .sort({ createdAt: -1 })
      .toArray();

    res.json(comments);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

app.post("/comments", async (req, res) => {
  try {
    const { lessonId, uid, name, photoURL, text } = req.body;
    if (!lessonId || !uid || !text) {
      return res.status(400).json({ message: "lessonId, uid, text required" });
    }

    const doc = {
      lessonId,
      uid,
      name: name || "",
      photoURL: photoURL || "",
      text,
      createdAt: new Date(),
    };

    await commentsCollection.insertOne(doc);

    //  cache counts 
    await lessonsCollection.updateOne(
      { _id: new ObjectId(lessonId) },
      { $inc: { commentsCount: 1 }, $set: { updatedAt: new Date() } }
    );

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});


  // Reports
 
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


  // ADMIN

  app.get("/admin/users", async (req, res) => {
    try {
      const users = await global.usersCollection.find().sort({ createdAt: -1 }).toArray();

      const lessonCounts = await lessonsCollection
        .aggregate([{ $group: { _id: "$creator.uid", total: { $sum: 1 } } }])
        .toArray();

      const countMap = {};
      lessonCounts.forEach((x) => (countMap[x._id] = x.total));

      const merged = users.map((u) => ({ ...u, lessonsCreated: countMap[u.uid] || 0 }));
      res.json(merged);
    } catch (e) {
      res.status(500).json({ message: e.message });
    }
  });

  app.patch("/admin/users/role", async (req, res) => {
    try {
      const { uid, role } = req.body;
      if (!uid || !role) return res.status(400).json({ message: "uid & role required" });

      const result = await global.usersCollection.updateOne(
        { uid },
        { $set: { role, updatedAt: new Date() } }
      );

      res.json({ success: true, result });
    } catch (e) {
      res.status(500).json({ message: e.message });
    }
  });

  app.delete("/admin/users/:uid", async (req, res) => {
    try {
      const { uid } = req.params;
      const result = await global.usersCollection.deleteOne({ uid });
      res.json({ success: true, result });
    } catch (e) {
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/admin/lessons", async (req, res) => {
    try {
      const { search = "", visibility = "", accessLevel = "", featured = "" } = req.query;

      const query = {};
      if (visibility) query.visibility = visibility;
      if (accessLevel) query.accessLevel = accessLevel;
      if (featured === "true") query.isFeatured = true;
      if (featured === "false") query.isFeatured = false;

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

  app.patch("/admin/lessons/:id/featured", async (req, res) => {
    try {
      const { id } = req.params;
      const { isFeatured } = req.body;

      const result = await lessonsCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { isFeatured: !!isFeatured, updatedAt: new Date() } }
      );

      res.json({ success: true, result });
    } catch (e) {
      res.status(500).json({ message: e.message });
    }
  });

  app.patch("/admin/lessons/:id/reviewed", async (req, res) => {
    try {
      const { id } = req.params;
      const { isReviewed } = req.body;

      const result = await lessonsCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { isReviewed: !!isReviewed, updatedAt: new Date() } }
      );

      res.json({ success: true, result });
    } catch (e) {
      res.status(500).json({ message: e.message });
    }
  });

// STATS: Top contributors of the week 

app.get("/stats/top-contributors", async (req, res) => {
  try {
    const since = new Date();
    since.setDate(since.getDate() - 7);

  
    const agg = await lessonsCollection
      .aggregate([
        { $match: { createdAt: { $gte: since } } },
        {
          $group: {
            _id: "$creator.uid",
            lessons: { $sum: 1 },
            name: { $first: "$creator.name" },
            photoURL: { $first: "$creator.photoURL" },
            photo: { $first: "$creator.photo" },
            email: { $first: "$creator.email" },
          },
        },
        { $sort: { lessons: -1 } },
        { $limit: 6 },
      ])
      .toArray();


    const uids = agg.map((x) => x._id);
    const users = await global.usersCollection
      .find({ uid: { $in: uids } })
      .project({ uid: 1, name: 1, photoURL: 1, email: 1 })
      .toArray();

    const map = {};
    users.forEach((u) => (map[u.uid] = u));

    const data = agg.map((x) => ({
      uid: x._id,
      lessons: x.lessons,
      name: x.name || map[x._id]?.name || "User",
      photoURL: x.photoURL || x.photo || map[x._id]?.photoURL || "",
      email: x.email || map[x._id]?.email || "",
    }));

    res.json(data);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});


// STATS: Most saved lessons 

app.get("/stats/most-saved", async (req, res) => {
  try {
    const agg = await favoritesCollection
      .aggregate([
        { $group: { _id: "$lessonId", saves: { $sum: 1 } } },
        { $sort: { saves: -1 } },
        { $limit: 6 },
      ])
      .toArray();

    const ids = agg.map((x) => new ObjectId(x._id));
    const lessons = await lessonsCollection
      .find(
        { _id: { $in: ids }, visibility: "public" },
        { projection: { title: 1, photoUrl: 1, category: 1, tone: 1, accessLevel: 1, createdAt: 1 } }
      )
      .toArray();

    const map = {};
    lessons.forEach((l) => (map[String(l._id)] = l));

    const merged = agg
      .map((x) => ({
        lessonId: x._id,
        saves: x.saves,
        lesson: map[x._id] || null,
      }))
      .filter((x) => x.lesson);

    res.json(merged);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

  app.delete("/admin/lessons/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const result = await lessonsCollection.deleteOne({ _id: new ObjectId(id) });
      res.json({ success: true, result });
    } catch (e) {
      res.status(500).json({ message: e.message });
    }
  });
}

run().catch((e) => console.log("❌ Server boot error:", e.message));

app.listen(port, () => {
  console.log(`✅ Server listening on port ${port}`);
});
