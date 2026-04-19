import os
from sqlalchemy import create_engine, Column, Integer, String, Float, DateTime, Boolean, Text
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
from datetime import datetime

_db_path = os.environ.get("DB_PATH", "/tmp/flight_tracker.db")
DATABASE_URL = f"sqlite:///{_db_path}"

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


class SearchJob(Base):
    __tablename__ = "search_jobs"

    id = Column(Integer, primary_key=True, index=True)
    from_airport = Column(String(10), nullable=False)
    to_airport = Column(String(10), nullable=False)
    date_from = Column(String(10), nullable=False)
    date_to = Column(String(10), nullable=False)
    seat_class = Column(String(20), default="economy")
    status = Column(String(20), default="pending")  # pending, running, done, error
    total_dates = Column(Integer, default=0)
    completed_dates = Column(Integer, default=0)
    error_message = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class FlightResult(Base):
    __tablename__ = "flight_results"

    id = Column(Integer, primary_key=True, index=True)
    search_job_id = Column(Integer, nullable=False, index=True)
    flight_date = Column(String(10), nullable=False)
    price = Column(Integer, nullable=False)
    currency = Column(String(5), default="USD")
    airlines = Column(String(500), nullable=False)
    duration_minutes = Column(Integer, nullable=False)
    stops = Column(Integer, nullable=False)
    departure_time = Column(String(10), nullable=True)
    arrival_time = Column(String(10), nullable=True)
    from_airport = Column(String(10), nullable=False)
    to_airport = Column(String(10), nullable=False)
    scraped_at = Column(DateTime, default=datetime.utcnow)


class PriceAlert(Base):
    __tablename__ = "price_alerts"

    id = Column(Integer, primary_key=True, index=True)
    from_airport = Column(String(10), nullable=False)
    to_airport = Column(String(10), nullable=False)
    threshold_price = Column(Integer, nullable=False)
    label = Column(String(200), nullable=True)
    active = Column(Boolean, default=True)
    triggered = Column(Boolean, default=False)
    triggered_price = Column(Integer, nullable=True)
    triggered_date = Column(String(10), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)


def init_db():
    Base.metadata.create_all(bind=engine)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
