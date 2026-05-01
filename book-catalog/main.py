import sqlite3
import threading
import json
import os
import logging
import time
from typing import Optional, List

import pika
from fastapi import FastAPI, HTTPException, Depends
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="Book Catalog Service",
    description="Microservice for managing the library book catalog. Communicates with Loan Service via RabbitMQ.",
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc",
)

DB_PATH = "/data/books.db"
RABBITMQ_URL = os.getenv("RABBITMQ_URL", "amqp://guest:guest@rabbitmq:5672/")


# ─── DB ───────────────────────────────────────────────────────────────────────

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()


def init_db():
    os.makedirs("/data", exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS books (
            id       INTEGER PRIMARY KEY AUTOINCREMENT,
            title    TEXT NOT NULL,
            author   TEXT NOT NULL,
            isbn     TEXT UNIQUE NOT NULL,
            genre    TEXT NOT NULL DEFAULT 'General',
            available BOOLEAN DEFAULT TRUE
        )
    """)
    sample = [
        ("The Pragmatic Programmer", "Hunt & Thomas",      "978-0135957059", "Technology"),
        ("Clean Code",              "Robert C. Martin",    "978-0132350884", "Technology"),
        ("Design Patterns",         "Gang of Four",        "978-0201633610", "Technology"),
        ("Dune",                    "Frank Herbert",       "978-0441013593", "Science Fiction"),
        ("1984",                    "George Orwell",       "978-0451524935", "Dystopia"),
    ]
    conn.executemany(
        "INSERT OR IGNORE INTO books (title, author, isbn, genre) VALUES (?, ?, ?, ?)", sample
    )
    conn.commit()
    conn.close()


# ─── RabbitMQ Consumer ────────────────────────────────────────────────────────

def on_loan_event(ch, method, properties, body):
    try:
        data = json.loads(body)
        book_id = data.get("book_id")
        event   = data.get("event")
        conn = sqlite3.connect(DB_PATH)
        if event == "book.borrowed":
            conn.execute("UPDATE books SET available = FALSE WHERE id = ?", (book_id,))
            logger.info(f"[RabbitMQ] Book {book_id} marked as BORROWED")
        elif event == "book.returned":
            conn.execute("UPDATE books SET available = TRUE WHERE id = ?", (book_id,))
            logger.info(f"[RabbitMQ] Book {book_id} marked as AVAILABLE")
        conn.commit()
        conn.close()
        ch.basic_ack(delivery_tag=method.delivery_tag)
    except Exception as e:
        logger.error(f"[RabbitMQ] Error processing message: {e}")
        ch.basic_nack(delivery_tag=method.delivery_tag, requeue=False)


def start_consumer():
    while True:
        try:
            connection = pika.BlockingConnection(pika.URLParameters(RABBITMQ_URL))
            channel = connection.channel()
            channel.exchange_declare(exchange="loan_events", exchange_type="direct", durable=True)
            channel.queue_declare(queue="book_availability", durable=True)
            channel.queue_bind(exchange="loan_events", queue="book_availability", routing_key="book.borrowed")
            channel.queue_bind(exchange="loan_events", queue="book_availability", routing_key="book.returned")
            channel.basic_qos(prefetch_count=1)
            channel.basic_consume(queue="book_availability", on_message_callback=on_loan_event)
            logger.info("[RabbitMQ] Consumer ready — waiting for loan events...")
            channel.start_consuming()
        except Exception as e:
            logger.error(f"[RabbitMQ] Connection lost: {e}. Reconnecting in 5s...")
            time.sleep(5)


# ─── Lifecycle ────────────────────────────────────────────────────────────────

@app.on_event("startup")
def startup():
    init_db()
    thread = threading.Thread(target=start_consumer, daemon=True)
    thread.start()


# ─── Schemas ──────────────────────────────────────────────────────────────────

class BookCreate(BaseModel):
    title:     str
    author:    str
    isbn:      str
    genre:     Optional[str] = "General"
    available: Optional[bool] = True


class BookResponse(BaseModel):
    id:        int
    title:     str
    author:    str
    isbn:      str
    genre:     str
    available: bool


# ─── Routes ───────────────────────────────────────────────────────────────────

@app.get("/books", response_model=List[BookResponse], tags=["Books"],
         summary="List all books")
def list_books(available: Optional[bool] = None, genre: Optional[str] = None,
               db: sqlite3.Connection = Depends(get_db)):
    """Return all books. Optionally filter by availability or genre."""
    query  = "SELECT * FROM books WHERE 1=1"
    params = []
    if available is not None:
        query += " AND available = ?"; params.append(available)
    if genre:
        query += " AND genre = ?"; params.append(genre)
    return [dict(r) for r in db.execute(query, params).fetchall()]


@app.get("/books/{book_id}", response_model=BookResponse, tags=["Books"],
         summary="Get a book by ID")
def get_book(book_id: int, db: sqlite3.Connection = Depends(get_db)):
    row = db.execute("SELECT * FROM books WHERE id = ?", (book_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Book not found")
    return dict(row)


@app.post("/books", response_model=BookResponse, status_code=201, tags=["Books"],
          summary="Add a new book to the catalog")
def create_book(book: BookCreate, db: sqlite3.Connection = Depends(get_db)):
    try:
        cur = db.execute(
            "INSERT INTO books (title, author, isbn, genre, available) VALUES (?, ?, ?, ?, ?)",
            (book.title, book.author, book.isbn, book.genre, book.available),
        )
        db.commit()
        return dict(db.execute("SELECT * FROM books WHERE id = ?", (cur.lastrowid,)).fetchone())
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=409, detail="ISBN already exists")


@app.put("/books/{book_id}", response_model=BookResponse, tags=["Books"],
         summary="Update a book")
def update_book(book_id: int, book: BookCreate, db: sqlite3.Connection = Depends(get_db)):
    if not db.execute("SELECT id FROM books WHERE id = ?", (book_id,)).fetchone():
        raise HTTPException(status_code=404, detail="Book not found")
    db.execute(
        "UPDATE books SET title=?, author=?, isbn=?, genre=?, available=? WHERE id=?",
        (book.title, book.author, book.isbn, book.genre, book.available, book_id),
    )
    db.commit()
    return dict(db.execute("SELECT * FROM books WHERE id = ?", (book_id,)).fetchone())


@app.delete("/books/{book_id}", tags=["Books"], summary="Delete a book")
def delete_book(book_id: int, db: sqlite3.Connection = Depends(get_db)):
    if not db.execute("SELECT id FROM books WHERE id = ?", (book_id,)).fetchone():
        raise HTTPException(status_code=404, detail="Book not found")
    db.execute("DELETE FROM books WHERE id = ?", (book_id,))
    db.commit()
    return {"message": "Book deleted successfully"}


@app.get("/health", tags=["Health"], summary="Health check")
def health():
    return {"status": "healthy", "service": "book-catalog"}
