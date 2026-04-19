from fast_flights import get_flights, FlightData, Passengers
from datetime import date, timedelta
import re
import logging

logger = logging.getLogger(__name__)

SOURCE = "Google Flights"


def parse_price(price_str: str) -> int | None:
    if not price_str:
        return None
    digits = re.sub(r'[^\d]', '', str(price_str))
    return int(digits) if digits else None


def parse_duration(duration_str: str) -> int:
    if not duration_str:
        return 0
    hours = re.search(r'(\d+)\s*h', str(duration_str))
    mins = re.search(r'(\d+)\s*m', str(duration_str))
    total = 0
    if hours:
        total += int(hours.group(1)) * 60
    if mins:
        total += int(mins.group(1))
    return total


def scrape_flights_for_date(
    from_airport: str,
    to_airport: str,
    flight_date: str,
    seat_class: str = "economy",
    currency: str = "USD",
) -> list[dict]:
    try:
        result = get_flights(
            flight_data=[FlightData(
                date=flight_date,
                from_airport=from_airport.upper(),
                to_airport=to_airport.upper(),
            )],
            trip="one-way",
            seat=seat_class,
            passengers=Passengers(adults=1),
        )

        flights = []
        for flight in (result.flights or []):
            price = parse_price(flight.price)
            if price is None:
                continue
            flights.append({
                "flight_date": flight_date,
                "price": price,
                "currency": currency,
                "source": SOURCE,
                "airlines": flight.name or "Unknown",
                "duration_minutes": parse_duration(flight.duration),
                "stops": flight.stops if flight.stops is not None else 0,
                "departure_time": flight.departure or None,
                "arrival_time": flight.arrival or None,
                "from_airport": from_airport.upper(),
                "to_airport": to_airport.upper(),
            })
        return flights

    except Exception as e:
        logger.warning(f"Failed to scrape {from_airport}->{to_airport} on {flight_date}: {e}")
        return []


def generate_date_range(date_from: str, date_to: str) -> list[str]:
    start = date.fromisoformat(date_from)
    end = date.fromisoformat(date_to)
    dates = []
    current = start
    while current <= end:
        dates.append(current.isoformat())
        current += timedelta(days=1)
    return dates
