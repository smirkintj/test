import os
from fastapi import FastAPI, Depends, BackgroundTasks, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, HTMLResponse
from sqlalchemy.orm import Session
from pydantic import BaseModel, field_validator
from datetime import datetime, date, timedelta
from typing import Optional
from collections import defaultdict
import logging

_STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")

from database import init_db, get_db, SearchJob, FlightResult, BestWindowResult, PriceAlert
from scraper import scrape_flights_for_date, generate_date_range

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Flight Price Tracker")

MAX_DATE_RANGE = 60
MAX_WINDOW_STARTS = 30  # cap for best-window searches


@app.on_event("startup")
def startup():
    init_db()


# ---------- Schemas ----------

class SearchRequest(BaseModel):
    from_airport: str
    to_airport: str
    date_from: str
    date_to: str
    seat_class: str = "economy"
    currency: str = "USD"

    @field_validator("from_airport", "to_airport")
    @classmethod
    def upper_airport(cls, v):
        return v.strip().upper()

    @field_validator("seat_class")
    @classmethod
    def valid_seat(cls, v):
        if v not in {"economy", "premium-economy", "business", "first"}:
            raise ValueError("Invalid seat class")
        return v

    @field_validator("date_from", "date_to")
    @classmethod
    def valid_date(cls, v):
        date.fromisoformat(v)
        return v


class BestWindowRequest(BaseModel):
    from_airport: str
    to_airport: str
    search_from: str
    search_to: str
    trip_days: int = 7
    seat_class: str = "economy"
    currency: str = "USD"

    @field_validator("from_airport", "to_airport")
    @classmethod
    def upper_airport(cls, v):
        return v.strip().upper()

    @field_validator("search_from", "search_to")
    @classmethod
    def valid_date(cls, v):
        date.fromisoformat(v)
        return v


class CompareRequest(BaseModel):
    from_airport: str
    to_airports: list[str]
    date_from: str
    date_to: str
    seat_class: str = "economy"
    currency: str = "USD"

    @field_validator("from_airport")
    @classmethod
    def upper_from(cls, v):
        return v.strip().upper()

    @field_validator("to_airports")
    @classmethod
    def upper_to_list(cls, v):
        return [x.strip().upper() for x in v if x.strip()]

    @field_validator("date_from", "date_to")
    @classmethod
    def valid_date(cls, v):
        date.fromisoformat(v)
        return v


class AlertRequest(BaseModel):
    from_airport: str
    to_airport: str
    threshold_price: int
    label: Optional[str] = None

    @field_validator("from_airport", "to_airport")
    @classmethod
    def upper_airport(cls, v):
        return v.strip().upper()


# ---------- Helpers ----------

def _job_status(job: SearchJob) -> dict:
    return {
        "id": job.id,
        "search_type": job.search_type,
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


def _check_alerts(db, from_airport, to_airport, flight_date, min_price):
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


# ---------- Background jobs ----------

def run_search_job(job_id, dates, from_airport, to_airport, seat_class, currency):
    from database import SessionLocal
    db = SessionLocal()
    try:
        job = db.query(SearchJob).filter(SearchJob.id == job_id).first()
        job.status = "running"
        db.commit()

        for flight_date in dates:
            flights = scrape_flights_for_date(from_airport, to_airport, flight_date, seat_class, currency)
            for f in flights:
                db.add(FlightResult(**f, search_job_id=job_id))
            if flights:
                _check_alerts(db, from_airport, to_airport, flight_date, min(f["price"] for f in flights))
            job.completed_dates += 1
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


def run_best_window_job(job_id, depart_dates, trip_days, from_airport, to_airport, seat_class, currency):
    from database import SessionLocal
    db = SessionLocal()
    try:
        job = db.query(SearchJob).filter(SearchJob.id == job_id).first()
        job.status = "running"
        job.total_dates = len(depart_dates)
        db.commit()

        for d in depart_dates:
            return_d = (date.fromisoformat(d) + timedelta(days=trip_days)).isoformat()
            outbound = scrape_flights_for_date(from_airport, to_airport, d, seat_class, currency)
            ret = scrape_flights_for_date(to_airport, from_airport, return_d, seat_class, currency)

            if outbound and ret:
                best_out = min(outbound, key=lambda x: x["price"])
                best_ret = min(ret, key=lambda x: x["price"])
                db.add(BestWindowResult(
                    search_job_id=job_id,
                    depart_date=d,
                    return_date=return_d,
                    outbound_price=best_out["price"],
                    return_price=best_ret["price"],
                    total_price=best_out["price"] + best_ret["price"],
                    outbound_airline=best_out["airlines"],
                    return_airline=best_ret["airlines"],
                ))

            job.completed_dates += 1
            db.commit()

        job.status = "done"
        job.updated_at = datetime.utcnow()
        db.commit()
    except Exception as e:
        logger.error(f"Best-window job {job_id} failed: {e}")
        job = db.query(SearchJob).filter(SearchJob.id == job_id).first()
        if job:
            job.status = "error"
            job.error_message = str(e)
            db.commit()
    finally:
        db.close()


def run_compare_job(job_id, dates, from_airport, to_airports, seat_class, currency):
    from database import SessionLocal
    db = SessionLocal()
    try:
        job = db.query(SearchJob).filter(SearchJob.id == job_id).first()
        job.status = "running"
        job.total_dates = len(dates) * len(to_airports)
        db.commit()

        for to_airport in to_airports:
            for d in dates:
                flights = scrape_flights_for_date(from_airport, to_airport, d, seat_class, currency)
                for f in flights:
                    db.add(FlightResult(**f, search_job_id=job_id))
                job.completed_dates += 1
                db.commit()

        job.status = "done"
        job.updated_at = datetime.utcnow()
        db.commit()
    except Exception as e:
        logger.error(f"Compare job {job_id} failed: {e}")
        job = db.query(SearchJob).filter(SearchJob.id == job_id).first()
        if job:
            job.status = "error"
            job.error_message = str(e)
            db.commit()
    finally:
        db.close()


# ---------- One-way search ----------

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
        search_type="one-way",
        from_airport=req.from_airport,
        to_airport=req.to_airport,
        date_from=req.date_from,
        date_to=req.date_to,
        seat_class=req.seat_class,
        total_dates=len(dates),
    )
    db.add(job)
    db.commit()
    db.refresh(job)
    background_tasks.add_task(run_search_job, job.id, dates, req.from_airport, req.to_airport, req.seat_class, req.currency)
    return {"search_id": job.id, "total_dates": len(dates), "status": "pending"}


@app.get("/api/search/{search_id}/status")
def get_search_status(search_id: int, db: Session = Depends(get_db)):
    job = db.query(SearchJob).filter(SearchJob.id == search_id).first()
    if not job:
        raise HTTPException(404, "Not found")
    return _job_status(job)


@app.get("/api/search/{search_id}/results")
def get_search_results(search_id: int, db: Session = Depends(get_db)):
    job = db.query(SearchJob).filter(SearchJob.id == search_id).first()
    if not job:
        raise HTTPException(404, "Not found")

    rows = db.query(FlightResult).filter(
        FlightResult.search_job_id == search_id
    ).order_by(FlightResult.flight_date, FlightResult.price).all()

    date_prices: dict[str, int] = {}
    for r in rows:
        if r.flight_date not in date_prices or r.price < date_prices[r.flight_date]:
            date_prices[r.flight_date] = r.price

    prices = list(date_prices.values())
    flights = [
        {
            "id": r.id, "flight_date": r.flight_date, "price": r.price,
            "currency": r.currency, "source": r.source, "airlines": r.airlines,
            "duration_minutes": r.duration_minutes, "stops": r.stops,
            "departure_time": r.departure_time, "arrival_time": r.arrival_time,
        }
        for r in rows
    ]
    trend = [{"date": d, "price": p} for d, p in sorted(date_prices.items())]

    return {
        "search_id": search_id, "status": job.status,
        "from_airport": job.from_airport, "to_airport": job.to_airport,
        "flights": flights, "calendar": date_prices, "trend": trend,
        "min_price": min(prices) if prices else None,
        "max_price": max(prices) if prices else None,
        "total_results": len(flights),
        "source": "Google Flights",
        "source_note": "Prices from Google Flights (aggregator) — airline websites may differ. Verify before booking.",
    }


# ---------- Best Window ----------

@app.post("/api/best-window")
def create_best_window(req: BestWindowRequest, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    d_from = date.fromisoformat(req.search_from)
    d_to = date.fromisoformat(req.search_to)
    if d_to < d_from:
        raise HTTPException(400, "search_to must be >= search_from")
    if req.trip_days < 1 or req.trip_days > 30:
        raise HTTPException(400, "trip_days must be 1–30")

    all_starts = generate_date_range(req.search_from, req.search_to)
    # ensure return date stays within a reasonable future
    valid_starts = [
        d for d in all_starts
        if (date.fromisoformat(d) + timedelta(days=req.trip_days)).isoformat() <= "2027-12-31"
    ][:MAX_WINDOW_STARTS]

    if not valid_starts:
        raise HTTPException(400, "No valid departure windows in range")

    job = SearchJob(
        search_type="best-window",
        from_airport=req.from_airport,
        to_airport=req.to_airport,
        date_from=req.search_from,
        date_to=req.search_to,
        seat_class=req.seat_class,
        trip_days=req.trip_days,
        total_dates=len(valid_starts),
    )
    db.add(job)
    db.commit()
    db.refresh(job)
    background_tasks.add_task(
        run_best_window_job, job.id, valid_starts, req.trip_days,
        req.from_airport, req.to_airport, req.seat_class, req.currency
    )
    return {"search_id": job.id, "windows_to_check": len(valid_starts), "status": "pending"}


@app.get("/api/best-window/{job_id}/status")
def get_best_window_status(job_id: int, db: Session = Depends(get_db)):
    job = db.query(SearchJob).filter(SearchJob.id == job_id, SearchJob.search_type == "best-window").first()
    if not job:
        raise HTTPException(404, "Not found")
    return _job_status(job)


@app.get("/api/best-window/{job_id}/results")
def get_best_window_results(job_id: int, db: Session = Depends(get_db)):
    job = db.query(SearchJob).filter(SearchJob.id == job_id).first()
    if not job:
        raise HTTPException(404, "Not found")

    windows = db.query(BestWindowResult).filter(
        BestWindowResult.search_job_id == job_id
    ).order_by(BestWindowResult.total_price).all()

    return {
        "search_id": job_id, "status": job.status,
        "from_airport": job.from_airport, "to_airport": job.to_airport,
        "trip_days": job.trip_days,
        "source": "Google Flights",
        "source_note": "Prices from Google Flights (aggregator) — airline websites may differ. Verify before booking.",
        "windows": [
            {
                "depart_date": w.depart_date, "return_date": w.return_date,
                "outbound_price": w.outbound_price, "return_price": w.return_price,
                "total_price": w.total_price,
                "outbound_airline": w.outbound_airline, "return_airline": w.return_airline,
                "source": w.source,
            }
            for w in windows
        ],
    }


# ---------- Destination Compare ----------

@app.post("/api/compare")
def create_compare(req: CompareRequest, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    if not req.to_airports:
        raise HTTPException(400, "Provide at least one destination")
    if len(req.to_airports) > 5:
        raise HTTPException(400, "Max 5 destinations")

    d_from = date.fromisoformat(req.date_from)
    d_to = date.fromisoformat(req.date_to)
    if (d_to - d_from).days > 14:
        raise HTTPException(400, "Date range for compare cannot exceed 14 days")

    dates = generate_date_range(req.date_from, req.date_to)
    job = SearchJob(
        search_type="compare",
        from_airport=req.from_airport,
        to_airport=",".join(req.to_airports),
        date_from=req.date_from,
        date_to=req.date_to,
        seat_class=req.seat_class,
        total_dates=len(dates) * len(req.to_airports),
    )
    db.add(job)
    db.commit()
    db.refresh(job)
    background_tasks.add_task(
        run_compare_job, job.id, dates, req.from_airport, req.to_airports, req.seat_class, req.currency
    )
    return {"search_id": job.id, "status": "pending"}


@app.get("/api/compare/{job_id}/status")
def get_compare_status(job_id: int, db: Session = Depends(get_db)):
    job = db.query(SearchJob).filter(SearchJob.id == job_id, SearchJob.search_type == "compare").first()
    if not job:
        raise HTTPException(404, "Not found")
    return _job_status(job)


@app.get("/api/compare/{job_id}/results")
def get_compare_results(job_id: int, db: Session = Depends(get_db)):
    job = db.query(SearchJob).filter(SearchJob.id == job_id).first()
    if not job:
        raise HTTPException(404, "Not found")

    rows = db.query(FlightResult).filter(FlightResult.search_job_id == job_id).all()

    # Group by destination, find cheapest per destination
    dest_map: dict[str, dict] = {}
    for r in rows:
        key = r.to_airport
        if key not in dest_map or r.price < dest_map[key]["cheapest_price"]:
            dest_map[key] = {
                "to_airport": r.to_airport, "cheapest_price": r.price,
                "cheapest_date": r.flight_date, "airline": r.airlines,
                "currency": r.currency, "source": r.source,
                "trip_com_url": _trip_com_url(job.from_airport, r.to_airport, r.flight_date),
                "gf_url": _gf_url(job.from_airport, r.to_airport, r.flight_date),
            }

    destinations = sorted(dest_map.values(), key=lambda x: x["cheapest_price"])
    return {
        "search_id": job_id, "status": job.status,
        "from_airport": job.from_airport,
        "source": "Google Flights",
        "source_note": "Prices from Google Flights (aggregator) — airline websites may differ. Verify before booking.",
        "destinations": destinations,
    }


# ---------- Price Intelligence (Feature 10) ----------

@app.get("/api/insights/{from_airport}/{to_airport}")
def get_insights(from_airport: str, to_airport: str, db: Session = Depends(get_db)):
    rows = db.query(FlightResult).filter(
        FlightResult.from_airport == from_airport.upper(),
        FlightResult.to_airport == to_airport.upper(),
    ).all()

    if len(rows) < 5:
        return {"insufficient_data": True, "data_points": len(rows),
                "message": f"Only {len(rows)} data points. Search this route more to build intelligence."}

    day_prices: dict[int, list] = defaultdict(list)
    advance_prices: dict[int, list] = defaultdict(list)

    for r in rows:
        d = date.fromisoformat(r.flight_date)
        day_prices[d.weekday()].append(r.price)
        if r.scraped_at:
            days_ahead = (d - r.scraped_at.date()).days
            if 0 <= days_ahead <= 180:
                bucket = days_ahead // 7
                advance_prices[bucket].append(r.price)

    day_names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    by_day = sorted([
        {"day": day_names[d], "avg_price": int(sum(p) / len(p)), "samples": len(p)}
        for d, p in day_prices.items()
    ], key=lambda x: x["avg_price"])

    by_advance = sorted([
        {"weeks_ahead": w, "avg_price": int(sum(p) / len(p)), "samples": len(p)}
        for w, p in advance_prices.items() if len(p) >= 2
    ], key=lambda x: x["avg_price"])

    all_prices = [r.price for r in rows]
    return {
        "insufficient_data": False,
        "data_points": len(rows),
        "route": f"{from_airport.upper()} → {to_airport.upper()}",
        "overall_min": min(all_prices),
        "overall_avg": int(sum(all_prices) / len(all_prices)),
        "overall_max": max(all_prices),
        "cheapest_day": by_day[0]["day"] if by_day else None,
        "best_booking_weeks_ahead": by_advance[0]["weeks_ahead"] if by_advance else None,
        "by_day_of_week": by_day,
        "by_weeks_in_advance": by_advance,
        "source": "Google Flights",
    }


# ---------- Shareable Trip Card (Feature 9) ----------

def _trip_com_url(frm: str, to: str, d: str) -> str:
    f, t = frm.lower(), to.lower()
    return f"https://www.trip.com/flights/{f}to{t}/tickets-{f}-{t}/?dcity={frm}&acity={to}&ddate={d}&adult=1&class=y"


def _gf_url(frm: str, to: str, d: str) -> str:
    return f"https://www.google.com/travel/flights?q=flights+from+{frm}+to+{to}+on+{d}"


@app.get("/api/share/{search_id}", response_class=HTMLResponse)
def share_card(search_id: int, db: Session = Depends(get_db)):
    job = db.query(SearchJob).filter(SearchJob.id == search_id).first()
    if not job:
        raise HTTPException(404, "Not found")

    rows = db.query(FlightResult).filter(
        FlightResult.search_job_id == search_id
    ).order_by(FlightResult.price).limit(5).all()

    cheapest = rows[0] if rows else None
    trip_url = _trip_com_url(job.from_airport, job.to_airport, cheapest.flight_date if cheapest else job.date_from)
    gf_url = _gf_url(job.from_airport, job.to_airport, cheapest.flight_date if cheapest else job.date_from)

    rows_html = "".join(f"""
        <tr>
          <td>{r.flight_date}</td>
          <td>{r.airlines}</td>
          <td>{r.departure_time or '—'} → {r.arrival_time or '—'}</td>
          <td>{'Direct' if r.stops == 0 else f'{r.stops} stop'}</td>
          <td class="price">${r.price:,} <small>{r.currency}</small></td>
        </tr>""" for r in rows)

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta property="og:title" content="✈ {job.from_airport} → {job.to_airport} — from ${cheapest.price if cheapest else '?'}">
  <meta property="og:description" content="Cheapest flights found for {job.date_from} to {job.date_to}. Check it out!">
  <title>{job.from_airport} → {job.to_airport} Trip Card</title>
  <style>
    *{{box-sizing:border-box;margin:0;padding:0}}
    body{{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f1117;color:#e8eaf0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}}
    .card{{background:#1a1d27;border:1px solid #2e3349;border-radius:16px;padding:32px;max-width:560px;width:100%}}
    .route{{font-size:36px;font-weight:800;letter-spacing:-1px;margin-bottom:4px}}
    .dates{{color:#7c82a0;font-size:14px;margin-bottom:24px}}
    .highlight{{font-size:48px;font-weight:900;color:#22c55e;margin-bottom:4px}}
    .highlight small{{font-size:16px;color:#7c82a0;font-weight:400}}
    table{{width:100%;border-collapse:collapse;margin:20px 0}}
    th{{text-align:left;padding:8px 10px;font-size:11px;color:#7c82a0;text-transform:uppercase;border-bottom:1px solid #2e3349}}
    td{{padding:10px;font-size:13px;border-bottom:1px solid rgba(46,51,73,.4)}}
    .price{{font-weight:700;color:#4f8ef7}}
    .btns{{display:flex;gap:12px;margin-top:20px}}
    .btn{{flex:1;padding:14px;border-radius:10px;border:none;font-size:14px;font-weight:700;cursor:pointer;text-decoration:none;text-align:center;display:block}}
    .btn-primary{{background:#e8173a;color:#fff}}
    .btn-secondary{{background:#1e2235;color:#e8eaf0;border:1px solid #2e3349}}
    .disclaimer{{font-size:11px;color:#7c82a0;margin-top:16px;line-height:1.5;padding:10px;background:rgba(79,142,247,.06);border-radius:8px;border-left:3px solid #4f8ef7}}
    .source-badge{{display:inline-flex;align-items:center;gap:6px;background:rgba(79,142,247,.1);border:1px solid rgba(79,142,247,.2);border-radius:999px;padding:4px 10px;font-size:11px;color:#4f8ef7;margin-bottom:16px}}
  </style>
</head>
<body>
  <div class="card">
    <div class="source-badge">📊 Google Flights data</div>
    <div class="route">{job.from_airport} → {job.to_airport}</div>
    <div class="dates">{job.date_from} to {job.date_to} · {job.seat_class.title()}</div>
    {'<div class="highlight">$' + f"{cheapest.price:,}" + ' <small>' + cheapest.currency + ' · cheapest found</small></div>' if cheapest else ''}
    <table>
      <thead><tr><th>Date</th><th>Airline</th><th>Times</th><th>Stops</th><th>Price</th></tr></thead>
      <tbody>{rows_html}</tbody>
    </table>
    <div class="btns">
      <a class="btn btn-primary" href="{trip_url}" target="_blank">Book on Trip.com</a>
      <a class="btn btn-secondary" href="{gf_url}" target="_blank">Check Google Flights</a>
    </div>
    <div class="disclaimer">⚠ Prices sourced from Google Flights (aggregator). Actual fares on airline websites or at checkout may differ. Always confirm before booking.</div>
  </div>
</body>
</html>"""


# ---------- Shared status + history ----------

@app.get("/api/searches")
def list_searches(db: Session = Depends(get_db)):
    jobs = db.query(SearchJob).order_by(SearchJob.created_at.desc()).limit(20).all()
    return [
        {"id": j.id, "search_type": j.search_type, "from_airport": j.from_airport,
         "to_airport": j.to_airport, "date_from": j.date_from, "date_to": j.date_to,
         "status": j.status, "created_at": j.created_at.isoformat()}
        for j in jobs
    ]


# ---------- Alerts ----------

@app.get("/api/alerts")
def get_alerts(db: Session = Depends(get_db)):
    alerts = db.query(PriceAlert).order_by(PriceAlert.created_at.desc()).all()
    return [
        {"id": a.id, "from_airport": a.from_airport, "to_airport": a.to_airport,
         "threshold_price": a.threshold_price, "label": a.label,
         "active": a.active, "triggered": a.triggered,
         "triggered_price": a.triggered_price, "triggered_date": a.triggered_date,
         "created_at": a.created_at.isoformat()}
        for a in alerts
    ]


@app.post("/api/alerts")
def create_alert(req: AlertRequest, db: Session = Depends(get_db)):
    alert = PriceAlert(
        from_airport=req.from_airport, to_airport=req.to_airport,
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
        raise HTTPException(404, "Not found")
    db.delete(alert)
    db.commit()
    return {"message": "deleted"}


@app.put("/api/alerts/{alert_id}/reset")
def reset_alert(alert_id: int, db: Session = Depends(get_db)):
    alert = db.query(PriceAlert).filter(PriceAlert.id == alert_id).first()
    if not alert:
        raise HTTPException(404, "Not found")
    alert.triggered = False
    alert.triggered_price = None
    alert.triggered_date = None
    db.commit()
    return {"message": "reset"}


# ---------- Static ----------

app.mount("/static", StaticFiles(directory=_STATIC_DIR), name="static")


@app.get("/")
def index():
    return FileResponse(os.path.join(_STATIC_DIR, "index.html"))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
