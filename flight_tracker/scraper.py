from fast_flights import FlightQuery, Passengers, create_query, get_flights
from datetime import date, timedelta
from typing import Optional
import logging

logger = logging.getLogger(__name__)


def scrape_flights_for_date(
    from_airport: str,
    to_airport: str,
    flight_date: str,
    seat_class: str = "economy",
    currency: str = "USD",
) -> list[dict]:
    """Scrape flights for a single date. Returns list of flight dicts."""
    try:
        query = create_query(
            flights=[
                FlightQuery(
                    date=flight_date,
                    from_airport=from_airport.upper(),
                    to_airport=to_airport.upper(),
                )
            ],
            seat=seat_class,
            trip="one-way",
            passengers=Passengers(adults=1),
            language="en-US",
            currency=currency,
        )

        results = get_flights(query)
        flights = []

        for flight in results:
            if not flight.flights:
                continue

            first_leg = flight.flights[0]
            last_leg = flight.flights[-1]

            dep_time = None
            arr_time = None
            if first_leg.departure and first_leg.departure.time:
                h, m = first_leg.departure.time
                dep_time = f"{h:02d}:{m:02d}"
            if last_leg.arrival and last_leg.arrival.time:
                h, m = last_leg.arrival.time
                arr_time = f"{h:02d}:{m:02d}"

            total_duration = sum(leg.duration for leg in flight.flights if leg.duration)
            stops = max(0, len(flight.flights) - 1)
            airlines_str = ", ".join(flight.airlines) if flight.airlines else "Unknown"

            flights.append(
                {
                    "flight_date": flight_date,
                    "price": flight.price,
                    "currency": currency,
                    "airlines": airlines_str,
                    "duration_minutes": total_duration,
                    "stops": stops,
                    "departure_time": dep_time,
                    "arrival_time": arr_time,
                    "from_airport": from_airport.upper(),
                    "to_airport": to_airport.upper(),
                }
            )

        return flights

    except Exception as e:
        logger.warning(f"Failed to scrape {from_airport}->{to_airport} on {flight_date}: {e}")
        return []


def generate_date_range(date_from: str, date_to: str) -> list[str]:
    """Generate list of date strings between date_from and date_to (inclusive)."""
    start = date.fromisoformat(date_from)
    end = date.fromisoformat(date_to)
    dates = []
    current = start
    while current <= end:
        dates.append(current.isoformat())
        current += timedelta(days=1)
    return dates
