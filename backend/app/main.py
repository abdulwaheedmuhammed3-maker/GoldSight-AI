from datetime import datetime, timezone
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI(
    title="GoldSight AI API",
    version="0.1.0",
    description="Initial API scaffold. Market quotes and forecasts are demo placeholders only.",
)

# Local development defaults. Restrict this list before production deployment.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "Authorization"],
)


class DemoForecast(BaseModel):
    direction: str
    note: str
    generated_at: datetime
    is_demo: bool = True


@app.get("/")
def root() -> dict[str, str]:
    return {"name": "GoldSight AI API", "docs": "/docs", "status": "scaffold"}


@app.get("/api/v1/health")
def health() -> dict[str, str]:
    return {
        "status": "ok",
        "service": "goldsight-api",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "market_data": "not_connected",
    }


@app.get("/api/v1/forecast/demo", response_model=DemoForecast)
def demo_forecast() -> DemoForecast:
    return DemoForecast(
        direction="NOT AVAILABLE",
        note="Demo endpoint only; no predictive model is connected.",
        generated_at=datetime.now(timezone.utc),
    )
