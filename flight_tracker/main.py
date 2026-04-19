from fastapi import FastAPI, Depends, BackgroundTasks, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session
from pydantic import BaseModel, field_validator
from datetime import datetime, date
from typing import Optional
import concurrent.futures
import logging

from database import init_db, get_db, SearchJob, FlightResult, PriceAlert
from scraper import scrape_flights_for_date, generate_date_range

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Flight Price Tracker")

MAX_DATE_RANGE = 60  # days
executor = concurrent.futures.ThreadPoolExecutor(max_workers=3)


@app.on_event("startup")
def startup():
    init_db()


# ---------- Pydantic schemas ----------

class SearchRequest(BaseModel):
    from_airport: str
    to_airport: str
    date_from: str
    date_to: str
    seat_class: str = "economy"
    currency: str = "USD"

    @field_validator("from_airport", "to_airport")
    @classmethod
    def upper_airport(cls, v: str) -> str:
        return v.strip().upper()

    @field_validator("seat_class")
    @classmethod
    def valid_seat(cls, v: str) -> str:
        allowed = {"economy", "premium-economy", "business", "first"}
        if v not in allowed:
            raise ValueError(f"seat_class must be one of {allowed}")
        return v

    @field_validator("date_from", "date_to")
    @classmethod
    def valid_date(cls, v: str) -> str:
        date.fromisoformat(v)
        return v


class AlertRequest(BaseModel):
    from_airport: str
    to_airport: str
    threshold_price: int
    label: Optional[str] = None

    @field_validator("from_airport", "to_airport")
    @classmethod
    def upper_airport(cls, v: str) -> str:
        return v.strip().upper()


# ---------- Background scraping ----------

def run_search_job(job_id: int, dates: list[str], from_airport: str, to_airport: str,
                   seat_class: str, currency: str):
    from database import SessionLocal
    db = SessionLocal()
    try:
        job = db.query(SearchJob).filter(SearchJob.id == job_id).first()
        if not job:
            return
        job.status = "running"
        job.total_dates = len(dates)
        db.commit()

        for flight_date in dates:
            flights = scrape_flights_for_date(from_airport, to_airport, flight_date, seat_class, currency)
            for f in flights:
                db.add(FlightResult(**f, search_job_id=job_id))

            job.completed_dates += 1
            db.commit()

            # Check alerts
            if flights:
                min_price = min(f["price"] for f in flights)
                alerts = db.query(PriceAlert).filter(
                    PriceAlert.from_airport == from_airport,
                    PriceAlert.to_airport == to_airport,
                    PriceAlert.active == True,
                    PriceAlert.triggered == False,
                    PriceAlert.threshold_price >= min_price,
                ).all()
                for alert in alerts:
                    alert.triggered = True
                    alert.triggered_price = min_price
                    alert.triggered_date = flight_date
                    logger.info(f"Alert triggered: {from_airport}->{to_airport} at ${min_price} on {flight_date}")
                db.commit()

        job.status = "done"
        job.updated_at = datetime.utcnow()
        db.commit()

    except Exception as e:
        logger.error(f"Search job {job_id} failed: {e}")
        job = db.query(SearchJob).filter(SearchJob.id == job_id).first()
        if job:
            job.status = "error"
            job.error_message = str(e)
            db.commit()
    finally:
        db.close()


# ---------- API Routes ----------

@app.post("/api/search")
def create_search(req: SearchRequest, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    d_from = date.fromisoformat(req.date_from)
    d_to = date.fromisoformat(req.date_to)
    if d_to < d_from:
        raise HTTPException(400, "date_to must be >= date_from")
    if (d_to - d_from).days > MAX_DATE_RANGE:
        raise HTTPException(400, f"Date range cannot exceed {MAX_DATE_RANGE} days")

    dates = generate_date_range(req.date_from, req.date_to)

    job = SearchJob(
        from_airport=req.from_airport,
        to_airport=req.to_airport,
        date_from=req.date_from,
        date_to=req.date_to,
        seat_class=req.seat_class,
        status="pending",
        total_dates=len(dates),
    )
    db.add(job)
    db.commit()
    db.refresh(job)

    background_tasks.add_task(
        run_search_job, job.id, dates,
        req.from_airport, req.to_airport, req.seat_class, req.currency
    )

    return {"search_id": job.id, "total_dates": len(dates), "status": "pending"}


@app.get("/api/search/{search_id}/status")
def get_search_status(search_id: int, db: Session = Depends(get_db)):
    job = db.query(SearchJob).filter(SearchJob.id == search_id).first()
    if not job:
        raise HTTPException(404, "Search job not found")
    return {
        "id": job.id,
        "from_airport": job.from_airport,
        "to_airport": job.to_airport,
        "date_from": job.date_from,
        "date_to": job.date_to,
        "status": job.status,
        "total_dates": job.total_dates,
        "completed_dates": job.completed_dates,
        "progress_pct": round(job.completed_dates / max(job.total_dates, 1) * 100, 1),
        "error_message": job.error_message,
    }


@app.get("/api/search/{search_id}/results")
def get_search_results(search_id: int, db: Session = Depends(get_db)):
    job = db.query(SearchJob).filter(SearchJob.id == search_id).first()
    if not job:
        raise HTTPException(404, "Search job not found")

    rows = (
        db.query(FlightResult)
        .filter(FlightResult.search_job_id == search_id)
        .order_by(FlightResult.flight_date, FlightResult.price)
        .all()
    )

    # Build per-date cheapest map for calendar
    date_prices: dict[str, int] = {}
    for r in rows:
        if r.flight_date not in date_prices or r.price < date_prices[r.flight_date]:
            date_prices[r.flight_date] = r.price

    all_prices = list(date_prices.values())
    min_price = min(all_prices) if all_prices else None
    max_price = max(all_prices) if all_prices else None

    flights = [
        {
            "id": r.id,
            "flight_date": r.flight_date,
            "price": r.price,
            "currency": r.currency,
            "airlines": r.airlines,
            "duration_minutes": r.duration_minutes,
            "stops": r.stops,
            "departure_time": r.departure_time,
            "arrival_time": r.arrival_time,
        }
        for r in rows
    ]

    # Trend: cheapest price per date
    trend = [
        {"date": d, "price": p}
        for d, p in sorted(date_prices.items())
    ]

    return {
        "search_id": search_id,
        "status": job.status,
        "from_airport": job.from_airport,
        "to_airport": job.to_airport,
        "flights": flights,
        "calendar": date_prices,
        "trend": trend,
        "min_price": min_price,
        "max_price": max_price,
        "total_results": len(flights),
    }


@app.get("/api/searches")
def list_searches(db: Session = Depends(get_db)):
    jobs = db.query(SearchJob).order_by(SearchJob.created_at.desc()).limit(20).all()
    return [
        {
            "id": j.id,
            "from_airport": j.from_airport,
            "to_airport": j.to_airport,
            "date_from": j.date_from,
            "date_to": j.date_to,
            "status": j.status,
            "created_at": j.created_at.isoformat(),
        }
        for j in jobs
    ]


@app.get("/api/alerts")
def get_alerts(db: Session = Depends(get_db)):
    alerts = db.query(PriceAlert).order_by(PriceAlert.created_at.desc()).all()
    return [
        {
            "id": a.id,
            "from_airport": a.from_airport,
            "to_airport": a.to_airport,
            "threshold_price": a.threshold_price,
            "label": a.label,
            "active": a.active,
            "triggered": a.triggered,
            "triggered_price": a.triggered_price,
            "triggered_date": a.triggered_date,
            "created_at": a.created_at.isoformat(),
        }
        for a in alerts
    ]


@app.post("/api/alerts")
def create_alert(req: AlertRequest, db: Session = Depends(get_db)):
    alert = PriceAlert(
        from_airport=req.from_airport,
        to_airport=req.to_airport,
        threshold_price=req.threshold_price,
        label=req.label or f"{req.from_airport}→{req.to_airport} under ${req.threshold_price}",
    )
    db.add(alert)
    db.commit()
    db.refresh(alert)
    return {"id": alert.id, "message": "Alert created"}


@app.delete("/api/alerts/{alert_id}")
def delete_alert(alert_id: int, db: Session = Depends(get_db)):
    alert = db.query(PriceAlert).filter(PriceAlert.id == alert_id).first()
    if not alert:
        raise HTTPException(404, "Alert not found")
    db.delete(alert)
    db.commit()
    return {"message": "Alert deleted"}


@app.put("/api/alerts/{alert_id}/reset")
def reset_alert(alert_id: int, db: Session = Depends(get_db)):
    alert = db.query(PriceAlert).filter(PriceAlert.id == alert_id).first()
    if not alert:
        raise HTTPException(404, "Alert not found")
    alert.triggered = False
    alert.triggered_price = None
    alert.triggered_date = None
    db.commit()
    return {"message": "Alert reset"}


# ---------- Static files ----------

app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
def index():
    return FileResponse("static/index.html")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
