from __future__ import annotations

import json
import logging
import os
import tempfile
from collections import Counter
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from threading import Lock
from typing import Literal
from uuid import UUID

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi_cache import FastAPICache
from fastapi_cache.backends.inmemory import InMemoryBackend
from fastapi_cache.decorator import cache
from pydantic import BaseModel, ConfigDict, Field, model_validator


DATA_FILE = Path(__file__).with_name("books.json")
_data_lock = Lock()
logger = logging.getLogger(__name__)


class TelemetryContext(BaseModel):
    model_config = ConfigDict(extra="forbid")

    app_version: str = Field(max_length=40)
    page_path: str | None = Field(max_length=300)
    referrer: str | None = Field(default=None, max_length=300)
    viewport_width: int | None = Field(default=None, ge=0)
    os: str | None = Field(default=None, max_length=80)
    language: str | None = Field(default=None, max_length=35)


class TelemetryMetadata(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sequence: int = Field(ge=1)
    batch_id: UUID
    sent_at: datetime
    emitter: str = Field(max_length=120)
    locale: str | None = Field(default=None, max_length=35)


class PageViewedProperties(BaseModel):
    model_config = ConfigDict(extra="forbid")

    path: str = Field(max_length=300)
    page: Literal["catalog", "book_detail"]
    book_id: int | None = Field(default=None, ge=1)


class AppErrorProperties(BaseModel):
    model_config = ConfigDict(extra="forbid")

    error_scope: Literal["render", "data_load", "route", "network"]
    message: str = Field(max_length=500)
    path: str | None = Field(default=None, max_length=300)


class TelemetryEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    event_id: UUID
    timestamp: datetime
    session_id: UUID
    user_id: str | None
    event_type: Literal["page_viewed", "app_error"]
    schema_version: str = Field(pattern=r"^[0-9]+\.[0-9]+\.[0-9]+$")
    request_id: UUID
    source: Literal["frontend"]
    context: TelemetryContext
    metadata: TelemetryMetadata
    properties: PageViewedProperties | AppErrorProperties

    @model_validator(mode="after")
    def properties_match_event_type(self):
        expected = PageViewedProperties if self.event_type == "page_viewed" else AppErrorProperties
        if not isinstance(self.properties, expected):
            raise ValueError("properties no coincide con event_type")
        if self.timestamp.tzinfo is None or self.metadata.sent_at.tzinfo is None:
            raise ValueError("timestamp y sent_at deben incluir zona horaria")
        return self


class TelemetryBatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    events: list[TelemetryEvent] = Field(min_length=1, max_length=50)


class BookCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    author: str = Field(min_length=1, max_length=160)
    genre: str = Field(min_length=1, max_length=100)
    year: int | None = Field(default=None, ge=0, le=2100)
    stock_id: str = Field(min_length=1, max_length=80)
    stock: int = Field(ge=0)


class Book(BookCreate):
    id: int


def _read_books() -> list[dict]:
    if not DATA_FILE.exists():
        return []
    with DATA_FILE.open("r", encoding="utf-8") as file:
        return json.load(file)


def _write_books(books: list[dict]) -> None:
    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_path = tempfile.mkstemp(
        prefix="books-", suffix=".json", dir=DATA_FILE.parent
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as file:
            json.dump(books, file, ensure_ascii=False, indent=2)
            file.write("\n")
        os.replace(temporary_path, DATA_FILE)
    finally:
        if os.path.exists(temporary_path):
            os.unlink(temporary_path)


@asynccontextmanager
async def lifespan(app: FastAPI):
    FastAPICache.init(InMemoryBackend(), prefix="bookstore-cache")
    yield


app = FastAPI(title="Bookstore Inventory API", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.post("/events")
def ingest_events(batch: TelemetryBatch) -> dict:
    event_types = Counter(event.event_type for event in batch.events)
    logger.info(
        "Telemetry batch accepted: count=%s event_types=%s",
        len(batch.events),
        dict(event_types),
    )
    return {"accepted": len(batch.events), "event_types": dict(event_types)}


@app.get("/books", response_model=list[Book])
@cache(expire=60, namespace="books")
def list_books() -> list[dict]:
    with _data_lock:
        return _read_books()


@app.get("/book/stock/{stock_id}")
@cache(expire=60, namespace="books")
def get_book_stock(stock_id: str) -> dict:
    with _data_lock:
        book = next((item for item in _read_books() if item["stock_id"] == stock_id), None)
    if book is None:
        raise HTTPException(status_code=404, detail="No se encontró un libro con ese stock_id")
    return {"book_id": book["id"], "title": book["title"], "stock_id": book["stock_id"], "stock": book["stock"]}


@app.get("/book/{book_id}", response_model=Book)
@cache(expire=60, namespace="books")
def get_book(book_id: int) -> dict:
    with _data_lock:
        book = next((item for item in _read_books() if item["id"] == book_id), None)
    if book is None:
        raise HTTPException(status_code=404, detail="Libro no encontrado")
    return book


@app.post("/book", response_model=Book, status_code=201)
async def create_book(book_data: BookCreate) -> dict:
    payload = book_data.model_dump()
    with _data_lock:
        books = _read_books()
        if any(item["stock_id"] == payload["stock_id"] for item in books):
            raise HTTPException(status_code=409, detail="El stock_id ya existe")
        new_book = {"id": max((item["id"] for item in books), default=0) + 1, **payload}
        books.append(new_book)
        _write_books(books)
    await FastAPICache.clear(namespace="books")
    return new_book
