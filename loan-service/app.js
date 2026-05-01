"use strict";

const express    = require("express");
const Database   = require("better-sqlite3");
const amqp       = require("amqplib");
const axios      = require("axios");
const swaggerJsdoc  = require("swagger-jsdoc");
const swaggerUi     = require("swagger-ui-express");
const fs   = require("fs");
const path = require("path");

// ─── Config ──────────────────────────────────────────────────────────────────
const PORT              = process.env.PORT              || 8002;
const RABBITMQ_URL      = process.env.RABBITMQ_URL      || "amqp://guest:guest@rabbitmq:5672/";
const BOOK_CATALOG_URL  = process.env.BOOK_CATALOG_URL  || "http://book-catalog:8001";
const DB_DIR            = "/data";
const DB_PATH           = path.join(DB_DIR, "loans.db");

// ─── Express ─────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// ─── SQLite ──────────────────────────────────────────────────────────────────
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS loans (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id       INTEGER NOT NULL,
    borrower_name TEXT    NOT NULL,
    borrowed_at   TEXT    DEFAULT (datetime('now')),
    returned_at   TEXT,
    status        TEXT    DEFAULT 'active'
  )
`);

// ─── RabbitMQ ─────────────────────────────────────────────────────────────────
let rabbitChannel = null;

async function connectRabbitMQ() {
  while (true) {
    try {
      const conn = await amqp.connect(RABBITMQ_URL);
      rabbitChannel = await conn.createChannel();
      await rabbitChannel.assertExchange("loan_events", "direct", { durable: true });
      console.log("[RabbitMQ] Connected and exchange declared");
      conn.on("close", () => {
        console.warn("[RabbitMQ] Connection closed. Reconnecting...");
        rabbitChannel = null;
        setTimeout(connectRabbitMQ, 5000);
      });
      return;
    } catch (err) {
      console.error(`[RabbitMQ] Connection failed: ${err.message}. Retrying in 5s...`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

async function publishEvent(routingKey, payload) {
  if (!rabbitChannel) {
    console.warn("[RabbitMQ] No channel — event dropped:", routingKey);
    return;
  }
  const msg = JSON.stringify({ event: routingKey, ...payload });
  rabbitChannel.publish("loan_events", routingKey, Buffer.from(msg), { persistent: true });
  console.log(`[RabbitMQ] Published event '${routingKey}':`, payload);
}

// ─── Swagger ──────────────────────────────────────────────────────────────────
const swaggerSpec = swaggerJsdoc({
  definition: {
    openapi: "3.0.0",
    info: {
      title:       "Loan Service API",
      version:     "1.0.0",
      description: "Microservice for managing library book loans. Publishes events to RabbitMQ when books are borrowed or returned.",
    },
    servers: [{ url: "/" }],
  },
  apis: [__filename],
});
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// ─── Routes ──────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /loans:
 *   get:
 *     summary: List all loans
 *     tags: [Loans]
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [active, returned]
 *         description: Filter by loan status
 *     responses:
 *       200:
 *         description: Array of loans
 */
app.get("/loans", (req, res) => {
  const { status } = req.query;
  const loans = status
    ? db.prepare("SELECT * FROM loans WHERE status = ?").all(status)
    : db.prepare("SELECT * FROM loans ORDER BY borrowed_at DESC").all();
  res.json(loans);
});

/**
 * @swagger
 * /loans/{id}:
 *   get:
 *     summary: Get a loan by ID
 *     tags: [Loans]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Loan object
 *       404:
 *         description: Loan not found
 */
app.get("/loans/:id", (req, res) => {
  const loan = db.prepare("SELECT * FROM loans WHERE id = ?").get(req.params.id);
  if (!loan) return res.status(404).json({ error: "Loan not found" });
  res.json(loan);
});

/**
 * @swagger
 * /loans:
 *   post:
 *     summary: Create a new loan (borrow a book)
 *     tags: [Loans]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [book_id, borrower_name]
 *             properties:
 *               book_id:
 *                 type: integer
 *                 example: 1
 *               borrower_name:
 *                 type: string
 *                 example: "Alice Martin"
 *     responses:
 *       201:
 *         description: Loan created. RabbitMQ event 'book.borrowed' published.
 *       400:
 *         description: Book not available or missing fields
 *       404:
 *         description: Book not found
 *       503:
 *         description: Book catalog service unreachable
 */
app.post("/loans", async (req, res) => {
  const { book_id, borrower_name } = req.body;
  if (!book_id || !borrower_name) {
    return res.status(400).json({ error: "book_id and borrower_name are required" });
  }

  // Check book availability — direct service-to-service HTTP call
  let book;
  try {
    const response = await axios.get(`${BOOK_CATALOG_URL}/books/${book_id}`, { timeout: 5000 });
    book = response.data;
  } catch (err) {
    if (err.response?.status === 404) {
      return res.status(404).json({ error: "Book not found in catalog" });
    }
    return res.status(503).json({ error: "Book catalog service unreachable" });
  }

  if (!book.available) {
    return res.status(400).json({ error: `Book '${book.title}' is not available — already on loan` });
  }

  const result = db.prepare("INSERT INTO loans (book_id, borrower_name) VALUES (?, ?)").run(book_id, borrower_name);
  const loan   = db.prepare("SELECT * FROM loans WHERE id = ?").get(result.lastInsertRowid);

  // Publish async event to RabbitMQ → book-catalog will update availability
  await publishEvent("book.borrowed", { book_id });

  res.status(201).json({ ...loan, book });
});

/**
 * @swagger
 * /loans/{id}/return:
 *   put:
 *     summary: Return a borrowed book
 *     tags: [Loans]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Book returned. RabbitMQ event 'book.returned' published.
 *       400:
 *         description: Book already returned
 *       404:
 *         description: Loan not found
 */
app.put("/loans/:id/return", async (req, res) => {
  const loan = db.prepare("SELECT * FROM loans WHERE id = ?").get(req.params.id);
  if (!loan)                    return res.status(404).json({ error: "Loan not found" });
  if (loan.status === "returned") return res.status(400).json({ error: "This book was already returned" });

  db.prepare("UPDATE loans SET status = 'returned', returned_at = datetime('now') WHERE id = ?").run(req.params.id);

  // Publish async event to RabbitMQ → book-catalog will restore availability
  await publishEvent("book.returned", { book_id: loan.book_id });

  const updated = db.prepare("SELECT * FROM loans WHERE id = ?").get(req.params.id);
  res.json(updated);
});

/**
 * @swagger
 * /health:
 *   get:
 *     summary: Health check
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: Service is healthy
 */
app.get("/health", (req, res) => {
  res.json({ status: "healthy", service: "loan-service", rabbitmq: rabbitChannel ? "connected" : "disconnected" });
});

// ─── Start ───────────────────────────────────────────────────────────────────
(async () => {
  await connectRabbitMQ();
  app.listen(PORT, () => {
    console.log(`Loan Service running on port ${PORT}`);
    console.log(`Swagger UI: http://localhost:${PORT}/api-docs`);
  });
})();
